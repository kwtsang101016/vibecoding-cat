import cors from "cors";
import express from "express";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server, type Socket } from "socket.io";
import { loadCredentialHashes, secretsMatch } from "./credentials.ts";
import { migrateLegacyIds } from "./legacyIds.ts";
import { durableStoreEnabled, loadClassroomState, persistClassroomState } from "./stateStore.ts";
import {
  createViewToken,
  getStudyPlan,
  listStudyPlans,
  loadStudyPlans,
  pruneViewTokens,
  resolveViewToken,
  saveStudyPlan,
  studyPlanMetaMap,
} from "./studyPlans.ts";
import {
  duplicateNames,
  getHtml,
  listParticipants,
  loadWorkshopStore,
  deleteParticipant,
  registerParticipant,
  renameParticipant,
  saveGithub,
  saveHtml,
  saveSurvey,
  surveySummary,
  workshopTaskMetaMap,
} from "./workshopStore.ts";
import {
  DEFAULT_STATE,
  addGuest,
  createGuestPerson,
  isGuestId,
  isSeatRef,
  normalizeProfile,
  placePerson,
  removeGuest,
  resetSeating,
  setLayout,
  unseatPerson,
  updateProfile,
} from "../shared/seating.ts";
import type {
  ClassroomState,
  LivePoll,
  Person,
  PollChoice,
  Roster,
  ServerSnapshot,
} from "../shared/types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const statePath = path.join(rootDir, "data", "state.json");
const studyPlansPath = path.join(rootDir, "data", "study-plans.json");
const rosterPath = path.join(rootDir, "src", "data", "roster.json");
const credentialsPath = path.join(rootDir, "server", "data", "credentials.json");
const distDir = path.join(rootDir, "dist");
const PORT = Number(process.env.PORT) || 3001;
const DEFAULT_PIN = "change-me-vibecoding";
const INSTRUCTOR_PIN = process.env.INSTRUCTOR_PIN || DEFAULT_PIN;
const STUDENT_ID_SALT = process.env.STUDENT_ID_SALT?.trim() ?? "";
/** Public planner URL used when minting instructor view links. */
const STUDY_PLANNER_PUBLIC_URL =
  process.env.STUDY_PLANNER_PUBLIC_URL?.trim() ||
  "https://kwtsang101016.github.io/dda1000/study_planner/";

interface SocketAuth {
  isInstructor: boolean;
  authorizedIds: Set<string>;
}

let state: ClassroomState = DEFAULT_STATE;
let personIds = new Set<string>();
let credentialHashes: Record<string, string | null> = {};

function getAuth(socket: Socket): SocketAuth {
  const data = socket.data as { auth?: SocketAuth };
  if (!data.auth) {
    data.auth = { isInstructor: false, authorizedIds: new Set() };
  }
  return data.auth;
}

function emitAuthState(socket: Socket): void {
  const auth = getAuth(socket);
  socket.emit("auth-state", {
    isInstructor: auth.isInstructor,
    authorizedIds: [...auth.authorizedIds],
  });
}

function findGuest(personId: string): Person | undefined {
  return (state.guests ?? []).find((guest) => guest.id === personId);
}

function isKnownPerson(personId: string): boolean {
  return personIds.has(personId) || Boolean(findGuest(personId));
}

function canControl(socket: Socket, personId: string): boolean {
  if (isGuestId(personId) && findGuest(personId)) {
    // Temporary auditor cards are open for the live session (no student ID).
    return true;
  }
  const auth = getAuth(socket);
  return auth.isInstructor || auth.authorizedIds.has(personId);
}

function requireControl(socket: Socket, personId: string): void {
  if (!canControl(socket, personId)) {
    throw new Error("Enter this person's student ID (or the instructor PIN) to continue.");
  }
}

function requireInstructor(socket: Socket): void {
  if (!getAuth(socket).isInstructor) {
    throw new Error("Only the instructor can change the table layout or reset seats.");
  }
}

async function loadRoster(): Promise<Roster> {
  try {
    const raw = await readFile(rosterPath, "utf8");
    const parsed = JSON.parse(raw) as Roster;
    if (!Array.isArray(parsed.people) || parsed.people.length === 0) {
      throw new Error("Roster does not contain any people.");
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `Failed to load class roster from ${rosterPath}: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

async function loadCredentials(): Promise<Record<string, string | null>> {
  return loadCredentialHashes(credentialsPath);
}

async function loadState(): Promise<ClassroomState> {
  return loadClassroomState(statePath);
}

async function persistState(next: ClassroomState, durable = false): Promise<void> {
  try {
    await persistClassroomState(statePath, next, { durable });
  } catch (error) {
    console.error("Failed to persist classroom state:", error);
  }
}

const POLL_CHOICES: PollChoice[] = ["A", "B", "C", "D"];

function emptyCounts(): Record<PollChoice, number> {
  return { A: 0, B: 0, C: 0, D: 0 };
}

function isPollChoice(value: unknown): value is PollChoice {
  return value === "A" || value === "B" || value === "C" || value === "D";
}

function snapshot(connectedCount: number, poll: LivePoll | null): ServerSnapshot {
  return { state, connectedCount, poll };
}

async function main(): Promise<void> {
  const roster = await loadRoster();
  credentialHashes = await loadCredentials();
  personIds = new Set(roster.people.map((person) => person.id));
  state = await loadState();
  await loadStudyPlans(studyPlansPath);
  await loadWorkshopStore();
  // Restore durable workshop cards into the live guest tray.
  const workshopPeople: Person[] = listParticipants().map((p) => ({
    id: p.id,
    name: p.name,
    englishName: "",
    role: "guest" as const,
    college: "",
    plan: "Workshop",
  }));
  const workshopById = new Map(workshopPeople.map((p) => [p.id, p]));
  const mergedGuests = [
    ...workshopPeople,
    ...(state.guests ?? []).filter((g) => !workshopById.has(g.id)),
  ];
  // Keep badge meta in classroom state in sync with durable plan / workshop stores.
  state = {
    ...state,
    guests: mergedGuests,
    studyPlanMeta: studyPlanMetaMap(),
    workshopTasks: workshopTaskMetaMap(),
  };

  if (STUDENT_ID_SALT) {
    const migration = migrateLegacyIds(state, credentialHashes, STUDENT_ID_SALT);
    if (migration.renamed > 0) {
      state = migration.state;
      await persistState(state, true);
      console.log(`Moved ${migration.renamed} saved seat/profile entries to the new card ids.`);
    }
    if (migration.unresolved > 0) {
      console.warn(
        `${migration.unresolved} saved entries still use old card ids. Check that STUDENT_ID_SALT matches credentials.json.`,
      );
    }
  } else {
    console.error("STUDENT_ID_SALT is not set. Students cannot log in until it is added on Render.");
  }

  // Migrate previous default layout (5×8) to the classroom layout (4×10).
  if (state.studentRowCount === 5 && state.seatsPerRow === 8) {
    state = setLayout(state, 4, 10);
    await persistState(state, true);
    console.log("Updated classroom layout default to 4 student rows × 10 seats.");
  }

  if (!durableStoreEnabled()) {
    console.warn(
      "No Upstash Redis configured. On Render, seating/profile data will be erased whenever the service redeploys.",
    );
  }

  if (INSTRUCTOR_PIN === DEFAULT_PIN) {
    console.warn(
      `INSTRUCTOR_PIN is still the default ("${DEFAULT_PIN}"). Set INSTRUCTOR_PIN on Render before class.`,
    );
  }

  const app = express();
  app.disable("x-powered-by");
  app.use(cors({ origin: true }));
  app.use(express.json({ limit: "2mb" }));

  /** Filled after Socket.IO is created — HTTP submit needs to refresh live badges. */
  let notifyClients: () => void = () => {};

  function refreshWorkshopBadges(): void {
    state = {
      ...state,
      workshopTasks: workshopTaskMetaMap(),
    };
  }

  function requireInstructorPin(value: unknown): void {
    if (typeof value !== "string" || value !== INSTRUCTOR_PIN) {
      throw new Error("Instructor PIN required.");
    }
  }

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      course: roster.course,
      section: roster.section,
      durableStore: durableStoreEnabled(),
      studyPlans: Object.keys(state.studyPlanMeta ?? {}).length,
      workshopCards: listParticipants().length,
      workshopSurveys: Object.keys(workshopTaskMetaMap()).filter((id) => workshopTaskMetaMap()[id].surveyAt)
        .length,
    });
  });

  /** Create a durable workshop name card (name + PIN). */
  app.post("/api/workshop/register", async (req, res) => {
    try {
      const { name, pin } = req.body as { name?: unknown; pin?: unknown };
      if (typeof name !== "string" || typeof pin !== "string") {
        throw new Error("Enter a display name and PIN.");
      }
      const participant = await registerParticipant(name, pin);
      const guest = createGuestPerson(participant.name, "");
      // Keep the stable id from the workshop store.
      const person: Person = {
        ...guest,
        id: participant.id,
        plan: "Workshop",
      };
      if (!findGuest(person.id)) {
        state = addGuest(state, person);
      }
      refreshWorkshopBadges();
      await persistState(state, true);
      notifyClients();
      res.json({ ok: true, personId: participant.id, name: participant.name });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not create the name card.";
      res.status(400).json({ ok: false, message });
    }
  });

  app.post("/api/workshop/survey", async (req, res) => {
    try {
      const { name, pin, answers } = req.body as {
        name?: unknown;
        pin?: unknown;
        answers?: unknown;
      };
      if (typeof name !== "string" || typeof pin !== "string") {
        throw new Error("Enter the name and PIN for your CAT card.");
      }
      const record = await saveSurvey(name, pin, answers);
      refreshWorkshopBadges();
      await persistState(state, true);
      notifyClients();
      res.json({ ok: true, personId: record.personId, submittedAt: record.submittedAt });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not submit the survey.";
      res.status(400).json({ ok: false, message });
    }
  });

  app.post("/api/workshop/html", async (req, res) => {
    try {
      const { name, pin, html } = req.body as {
        name?: unknown;
        pin?: unknown;
        html?: unknown;
      };
      if (typeof name !== "string" || typeof pin !== "string") {
        throw new Error("Enter the name and PIN for your CAT card.");
      }
      if (typeof html !== "string") {
        throw new Error("Upload an HTML file.");
      }
      const record = await saveHtml(name, pin, html);
      refreshWorkshopBadges();
      await persistState(state, true);
      notifyClients();
      res.json({
        ok: true,
        personId: record.personId,
        submittedAt: record.submittedAt,
        byteLength: record.byteLength,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not submit the HTML file.";
      res.status(400).json({ ok: false, message });
    }
  });

  app.post("/api/workshop/github", async (req, res) => {
    try {
      const { name, pin, url } = req.body as {
        name?: unknown;
        pin?: unknown;
        url?: unknown;
      };
      if (typeof name !== "string" || typeof pin !== "string" || typeof url !== "string") {
        throw new Error("Enter name, PIN, and GitHub URL.");
      }
      const record = await saveGithub(name, pin, url);
      refreshWorkshopBadges();
      await persistState(state, true);
      notifyClients();
      res.json({ ok: true, personId: record.personId, submittedAt: record.submittedAt, url: record.url });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not submit the GitHub link.";
      res.status(400).json({ ok: false, message });
    }
  });

  app.post("/api/workshop/duplicates", (req, res) => {
    try {
      const { instructorPin } = req.body as { instructorPin?: unknown };
      requireInstructorPin(instructorPin);
      res.json({ ok: true, duplicates: duplicateNames() });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not check duplicates.";
      res.status(400).json({ ok: false, message });
    }
  });

  app.post("/api/workshop/survey-summary", (req, res) => {
    try {
      const { instructorPin } = req.body as { instructorPin?: unknown };
      requireInstructorPin(instructorPin);
      res.json({ ok: true, summary: surveySummary() });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load survey summary.";
      res.status(400).json({ ok: false, message });
    }
  });

  app.post("/api/workshop/html/view", (req, res) => {
    try {
      const { instructorPin, personId } = req.body as {
        instructorPin?: unknown;
        personId?: unknown;
      };
      requireInstructorPin(instructorPin);
      if (typeof personId !== "string") throw new Error("Missing personId.");
      const record = getHtml(personId);
      if (!record) throw new Error("No HTML submitted for that card yet.");
      res.json({
        ok: true,
        personId: record.personId,
        name: record.name,
        submittedAt: record.submittedAt,
        html: record.html,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not open that HTML file.";
      res.status(400).json({ ok: false, message });
    }
  });

  app.post("/api/workshop/rename", async (req, res) => {
    try {
      const { instructorPin, personId, newName } = req.body as {
        instructorPin?: unknown;
        personId?: unknown;
        newName?: unknown;
      };
      requireInstructorPin(instructorPin);
      if (typeof personId !== "string" || typeof newName !== "string") {
        throw new Error("personId and newName are required.");
      }
      const updated = await renameParticipant(personId, newName);
      state = {
        ...state,
        guests: (state.guests ?? []).map((g) =>
          g.id === personId ? { ...g, name: updated.name } : g,
        ),
      };
      await persistState(state, true);
      notifyClients();
      res.json({ ok: true, personId: updated.id, name: updated.name });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not rename that card.";
      res.status(400).json({ ok: false, message });
    }
  });

  /** Public roster cards for the study-planner “Submit to CAT” picker. */
  app.get("/api/roster-cards", (_req, res) => {
    res.json({
      course: roster.course,
      section: roster.section,
      people: roster.people
        .filter((p) => p.role === "student" || p.role === "pa")
        .map((p) => ({
          id: p.id,
          name: p.name,
          englishName: p.englishName,
          role: p.role,
        })),
    });
  });

  /** Student submits a planner JSON export (overwrites previous submission). */
  app.post("/api/study-plans/submit", async (req, res) => {
    try {
      const { personId, studentId, plan } = req.body as {
        personId?: unknown;
        studentId?: unknown;
        plan?: unknown;
      };
      if (typeof personId !== "string" || !personIds.has(personId)) {
        throw new Error("Unknown name card.");
      }
      if (typeof studentId !== "string" || !studentId.trim()) {
        throw new Error("Enter your student ID.");
      }
      const expected = credentialHashes[personId];
      if (!expected) {
        throw new Error("This card cannot receive study-plan submissions.");
      }
      if (!STUDENT_ID_SALT) {
        throw new Error("Student login is not configured on the server yet.");
      }
      if (!secretsMatch(studentId, expected, STUDENT_ID_SALT)) {
        throw new Error("Student ID does not match that name card.");
      }

      const record = await saveStudyPlan(studyPlansPath, personId, plan);
      state = {
        ...state,
        studyPlanMeta: {
          ...(state.studyPlanMeta ?? {}),
          [personId]: {
            submittedAt: record.submittedAt,
            major: record.major,
            feStream: record.feStream,
          },
        },
      };
      await persistState(state, true);
      notifyClients();

      res.json({
        ok: true,
        personId,
        submittedAt: record.submittedAt,
        major: record.major,
        feStream: record.feStream,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not submit the study plan.";
      res.status(400).json({ ok: false, message });
    }
  });

  function publicStudyPlans() {
    const peopleById = new Map(roster.people.map((person) => [person.id, person]));
    return listStudyPlans().map((record) => {
      const person = peopleById.get(record.personId);
      return {
        personId: record.personId,
        name: person?.name ?? record.personId,
        englishName: person?.englishName ?? "",
        role: person?.role ?? "student",
        submittedAt: record.submittedAt,
        major: record.major,
        feStream: record.feStream,
        plan: record.plan,
      };
    });
  }

  /**
   * Class-readable copies for the public calendar. These are the same plans an
   * instructor opens from a name card. Student ID numbers are not included.
   */
  app.get("/api/study-plans/shared", (_req, res) => {
    const plans = publicStudyPlans();
    res.json({
      ok: true,
      course: roster.course,
      section: roster.section,
      exportedAt: new Date().toISOString(),
      count: plans.length,
      plans,
    });
  });

  app.get("/api/study-plans/shared/:personId", (req, res) => {
    const plan = publicStudyPlans().find((entry) => entry.personId === req.params.personId);
    if (!plan) {
      res.status(404).json({ ok: false, message: "That student has not submitted a study plan yet." });
      return;
    }
    res.json({ ok: true, ...plan });
  });

  /** Instructor downloads every submitted plan (names and planner JSON, no student IDs). */
  app.post("/api/study-plans/export", (req, res) => {
    try {
      const { instructorPin } = req.body as { instructorPin?: unknown };
      if (typeof instructorPin !== "string" || instructorPin !== INSTRUCTOR_PIN) {
        throw new Error("Instructor PIN is incorrect.");
      }
      const exported = publicStudyPlans();
      res.json({
        ok: true,
        course: roster.course,
        section: roster.section,
        exportedAt: new Date().toISOString(),
        count: exported.length,
        plans: exported,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not export study plans.";
      res.status(400).json({ ok: false, message });
    }
  });

  /** Instructor mints a short-lived link to open a plan in the study planner. */
  app.post("/api/study-plans/view-token", (req, res) => {
    try {
      pruneViewTokens();
      const { personId, instructorPin } = req.body as {
        personId?: unknown;
        instructorPin?: unknown;
      };
      if (typeof instructorPin !== "string" || instructorPin !== INSTRUCTOR_PIN) {
        throw new Error("Instructor PIN is incorrect.");
      }
      if (typeof personId !== "string" || !personIds.has(personId)) {
        throw new Error("Unknown name card.");
      }
      if (!getStudyPlan(personId)) {
        throw new Error("That student has not submitted a study plan yet.");
      }
      const { token, expiresAt } = createViewToken(personId);
      const base = STUDY_PLANNER_PUBLIC_URL.endsWith("/")
        ? STUDY_PLANNER_PUBLIC_URL
        : `${STUDY_PLANNER_PUBLIC_URL}/`;
      const viewUrl = `${base}?catToken=${encodeURIComponent(token)}`;
      res.json({ ok: true, token, expiresAt, viewUrl });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not create a view link.";
      res.status(400).json({ ok: false, message });
    }
  });

  /** Planner fetches a submitted plan via view token (no PIN in the URL). */
  app.get("/api/study-plans/view/:token", (req, res) => {
    try {
      pruneViewTokens();
      const record = resolveViewToken(req.params.token);
      const person = roster.people.find((p) => p.id === record.personId);
      res.json({
        ok: true,
        personId: record.personId,
        name: person?.name ?? record.personId,
        englishName: person?.englishName ?? "",
        submittedAt: record.submittedAt,
        major: record.major,
        feStream: record.feStream,
        plan: record.plan,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load that study plan.";
      res.status(400).json({ ok: false, message });
    }
  });

  const hasDist = existsSync(distDir);
  if (hasDist) {
    app.use(express.static(distDir));
    app.use((req, res, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        next();
        return;
      }
      if (
        req.path.startsWith("/socket.io") ||
        req.path.startsWith("/api/") ||
        req.path === "/health"
      ) {
        next();
        return;
      }
      res.sendFile(path.join(distDir, "index.html"), (error) => {
        if (error) {
          next(error);
        }
      });
    });
  }

  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: { origin: true },
    pingInterval: 8000,
    pingTimeout: 15000,
    maxHttpBufferSize: 3e5,
  });


  /**
   * Session stays open by default. Render suspend/resume replaces the old
   * open/close workflow, so we no longer auto-close or kick clients.
   */
  let sessionOpen = true;
  const IDLE_CLOSE_MS = 3 * 60 * 60 * 1000;
  let idleCloseTimer: ReturnType<typeof setTimeout> | null = null;

  let livePoll: LivePoll | null = null;
  /** Anonymous voter id (client session) → choice. */
  const pollVotes = new Map<string, PollChoice>();

  const buildPollPublic = (): LivePoll | null => {
    if (!livePoll) {
      return null;
    }
    const counts = emptyCounts();
    for (const choice of pollVotes.values()) {
      counts[choice] += 1;
    }
    return {
      ...livePoll,
      counts,
      totalVotes: pollVotes.size,
    };
  };

  const emitState = (): void => {
    io.emit("snapshot", snapshot(io.engine.clientsCount, buildPollPublic()));
  };
  notifyClients = emitState;

  const emitPoll = (): void => {
    io.emit("poll-state", buildPollPublic());
  };

  const clearPoll = (): void => {
    livePoll = null;
    pollVotes.clear();
    emitPoll();
  };

  const emitSessionStatus = (reason?: string): void => {
    io.emit("session-status", { open: sessionOpen, reason });
  };

  const countInstructors = (): number => {
    let count = 0;
    for (const socket of io.sockets.sockets.values()) {
      if (getAuth(socket).isInstructor) {
        count += 1;
      }
    }
    return count;
  };

  const clearIdleCloseTimer = (): void => {
    if (idleCloseTimer) {
      clearTimeout(idleCloseTimer);
      idleCloseTimer = null;
    }
  };

  const closeSession = (reason: "closed" | "idle"): void => {
    // Kept for optional instructor use; does not disconnect clients anymore.
    clearIdleCloseTimer();
    sessionOpen = false;
    livePoll = null;
    pollVotes.clear();
    emitSessionStatus(reason);
  };

  const scheduleIdleClose = (): void => {
    // No-op: idle auto-close disabled (Render suspend covers free-tier hours).
    clearIdleCloseTimer();
    void IDLE_CLOSE_MS;
  };

  const refreshInstructorPresence = (): void => {
    clearIdleCloseTimer();
    void countInstructors;
  };

  const requireOpenSession = (_socket: Socket): void => {
    // Session gating disabled — classroom is usable whenever the service is awake.
  };

  io.on("connection", (socket) => {
    getAuth(socket);
    emitAuthState(socket);
    socket.emit("session-status", { open: sessionOpen });
    socket.emit("snapshot", snapshot(io.engine.clientsCount, buildPollPublic()));
    socket.emit("poll-state", buildPollPublic());
    socket.broadcast.emit("presence", { connectedCount: io.engine.clientsCount });

    socket.on("authorize", (payload: unknown, ack?: (response: { ok: boolean; message?: string }) => void) => {
      try {
        if (typeof payload !== "object" || payload === null) {
          throw new Error("Invalid authorization payload.");
        }
        const { personId, secret, asInstructor } = payload as {
          personId?: unknown;
          secret?: unknown;
          asInstructor?: unknown;
        };
        if (typeof secret !== "string" || !secret.trim()) {
          throw new Error("Enter a student ID or instructor PIN.");
        }

        const auth = getAuth(socket);

        if (asInstructor) {
          if (secret !== INSTRUCTOR_PIN) {
            throw new Error("Instructor PIN is incorrect.");
          }
          auth.isInstructor = true;
          emitAuthState(socket);
          refreshInstructorPresence();
          ack?.({ ok: true });
          return;
        }

        if (typeof personId !== "string" || !personIds.has(personId)) {
          throw new Error("Unknown name card.");
        }

        const expected = credentialHashes[personId];
        if (!expected) {
          throw new Error("This card can only be managed with the instructor PIN.");
        }
        if (!STUDENT_ID_SALT) {
          throw new Error("Student login is not configured on the server yet. Please tell the instructor.");
        }
        if (!secretsMatch(secret, expected, STUDENT_ID_SALT)) {
          throw new Error("Student ID does not match.");
        }

        auth.authorizedIds.add(personId);
        emitAuthState(socket);
        ack?.({ ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Authorization failed.";
        ack?.({ ok: false, message });
        socket.emit("error-message", message);
      }
    });

    socket.on("openSession", () => {
      try {
        requireInstructor(socket);
        sessionOpen = true;
        clearIdleCloseTimer();
        emitSessionStatus("opened");
        emitState();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not open the session.";
        socket.emit("error-message", message);
      }
    });

    socket.on("closeSession", () => {
      try {
        requireInstructor(socket);
        closeSession("closed");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not close the session.";
        socket.emit("error-message", message);
      }
    });

    socket.on("pollStart", (payload: unknown) => {
      try {
        requireInstructor(socket);
        if (typeof payload !== "object" || payload === null) {
          throw new Error("Invalid poll payload.");
        }
        const { question, optionLabels } = payload as {
          question?: unknown;
          optionLabels?: unknown;
        };
        // Question text is optional — often the stem is already on the lecture slides.
        const questionText =
          typeof question === "string" && question.trim()
            ? question.trim().slice(0, 240)
            : "Vote now — see the question on the slide";
        const labels: Record<PollChoice, string> = { A: "", B: "", C: "", D: "" };
        if (optionLabels && typeof optionLabels === "object") {
          for (const key of POLL_CHOICES) {
            const raw = (optionLabels as Record<string, unknown>)[key];
            if (typeof raw === "string") {
              labels[key] = raw.trim().slice(0, 80);
            }
          }
        }
        livePoll = {
          id: `poll-${Date.now().toString(36)}`,
          question: questionText,
          optionLabels: labels,
          status: "open",
          counts: emptyCounts(),
          totalVotes: 0,
        };
        pollVotes.clear();
        emitPoll();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not start the poll.";
        socket.emit("error-message", message);
      }
    });

    socket.on("pollLock", () => {
      try {
        requireInstructor(socket);
        if (!livePoll) {
          throw new Error("No active poll.");
        }
        livePoll = { ...livePoll, status: "locked" };
        emitPoll();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not lock the poll.";
        socket.emit("error-message", message);
      }
    });

    socket.on("pollClear", () => {
      try {
        requireInstructor(socket);
        clearPoll();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not clear the poll.";
        socket.emit("error-message", message);
      }
    });

    socket.on("pollVote", (payload: unknown) => {
      try {
        if (!livePoll || livePoll.status !== "open") {
          throw new Error("Voting is closed for this poll.");
        }
        if (typeof payload !== "object" || payload === null) {
          throw new Error("Invalid vote.");
        }
        const { choice, voterId } = payload as { choice?: unknown; voterId?: unknown };
        if (!isPollChoice(choice)) {
          throw new Error("Choose A, B, C, or D.");
        }
        if (typeof voterId !== "string" || voterId.trim().length < 8 || voterId.trim().length > 80) {
          throw new Error("Could not record an anonymous vote. Refresh and try again.");
        }
        pollVotes.set(voterId.trim(), choice);
        emitPoll();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not record your vote.";
        socket.emit("error-message", message);
      }
    });

    socket.on("place", async (payload: unknown) => {
      try {
        requireOpenSession(socket);
        if (typeof payload !== "object" || payload === null) {
          throw new Error("Invalid place payload.");
        }
        const { personId, target } = payload as { personId?: unknown; target?: unknown };
        if (typeof personId !== "string" || !isKnownPerson(personId)) {
          throw new Error("Unknown name card.");
        }
        if (!isSeatRef(target)) {
          throw new Error("Invalid seat.");
        }
        requireControl(socket, personId);
        state = placePerson(state, personId, target);
        await persistState(state, false);
        emitState();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not place that card.";
        socket.emit("error-message", message);
      }
    });

    socket.on("unseat", async (payload: unknown) => {
      try {
        requireOpenSession(socket);
        if (typeof payload !== "object" || payload === null) {
          throw new Error("Invalid unseat payload.");
        }
        const { personId } = payload as { personId?: unknown };
        if (typeof personId !== "string" || !isKnownPerson(personId)) {
          throw new Error("Unknown name card.");
        }
        requireControl(socket, personId);
        state = unseatPerson(state, personId);
        await persistState(state, false);
        emitState();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not return that card.";
        socket.emit("error-message", message);
      }
    });

    socket.on("setLayout", async (payload: unknown) => {
      try {
        requireInstructor(socket);
        requireOpenSession(socket);
        if (typeof payload !== "object" || payload === null) {
          throw new Error("Invalid layout payload.");
        }
        const { studentRowCount, seatsPerRow } = payload as {
          studentRowCount?: unknown;
          seatsPerRow?: unknown;
        };
        if (typeof studentRowCount !== "number" || typeof seatsPerRow !== "number") {
          throw new Error("Row and seat counts must be numbers.");
        }
        state = setLayout(state, studentRowCount, seatsPerRow);
        await persistState(state, false);
        emitState();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not update the layout.";
        socket.emit("error-message", message);
      }
    });

    socket.on("updateProfile", async (payload: unknown) => {
      try {
        requireOpenSession(socket);
        if (typeof payload !== "object" || payload === null) {
          throw new Error("Invalid profile payload.");
        }
        const { personId, profile } = payload as { personId?: unknown; profile?: unknown };
        if (typeof personId !== "string" || !isKnownPerson(personId)) {
          throw new Error("Unknown name card.");
        }
        requireControl(socket, personId);
        const normalized = normalizeProfile(profile);
        state = updateProfile(state, personId, normalized);
        // Roster profile edits go to Redis; temporary guest cards stay session-only.
        await persistState(state, !isGuestId(personId));
        emitState();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not save the name card.";
        socket.emit("error-message", message);
      }
    });

    socket.on("addGuest", async (payload: unknown) => {
      try {
        requireOpenSession(socket);
        if (typeof payload !== "object" || payload === null) {
          throw new Error("Invalid name card payload.");
        }
        const { name, pin } = payload as { name?: unknown; pin?: unknown };
        if (typeof name !== "string" || typeof pin !== "string") {
          throw new Error("Enter a display name and a PIN (at least 4 characters).");
        }
        const participant = await registerParticipant(name, pin);
        const guest = createGuestPerson(participant.name, "");
        const person: Person = { ...guest, id: participant.id, plan: "Workshop" };
        state = addGuest(state, person);
        refreshWorkshopBadges();
        await persistState(state, true);
        emitState();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not create the name card.";
        socket.emit("error-message", message);
      }
    });

    socket.on("removeGuest", async (payload: unknown) => {
      try {
        requireInstructor(socket);
        requireOpenSession(socket);
        if (typeof payload !== "object" || payload === null) {
          throw new Error("Invalid name card payload.");
        }
        const { personId } = payload as { personId?: unknown };
        if (typeof personId !== "string" || !findGuest(personId)) {
          throw new Error("Unknown workshop name card.");
        }
        await deleteParticipant(personId);
        state = removeGuest(state, personId);
        refreshWorkshopBadges();
        await persistState(state, true);
        emitState();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not delete that name card.";
        socket.emit("error-message", message);
      }
    });

    socket.on("reset", async () => {
      try {
        requireInstructor(socket);
        requireOpenSession(socket);
        state = resetSeating(state);
        await persistState(state, false);
        emitState();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not reset the table.";
        socket.emit("error-message", message);
      }
    });

    socket.on("disconnect", () => {
      socket.broadcast.emit("presence", { connectedCount: Math.max(0, io.engine.clientsCount) });
      refreshInstructorPresence();
    });
  });

  const flushDurable = async (reason: string): Promise<void> => {
    try {
      await persistState(state, true);
      console.log(`Flushed classroom state to Redis (${reason}).`);
    } catch (error) {
      console.error(`Failed to flush classroom state on ${reason}:`, error);
    }
  };

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      void flushDurable(signal).finally(() => {
        process.exit(0);
      });
    });
  }

  httpServer.on("error", (error) => {
    console.error("Classroom server failed:", error);
    process.exitCode = 1;
  });

  httpServer.listen(PORT, () => {
    console.log(`Vibe Coding CAT listening on http://localhost:${PORT} (session open by default)`);
  });
}

main().catch((error) => {
  console.error("Failed to start classroom server:", error);
  process.exit(1);
});
