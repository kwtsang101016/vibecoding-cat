import { useMemo, useRef, useState, type ReactNode } from "react";
import rosterData from "./data/roster.json" with { type: "json" };
import { AuthModal } from "./components/AuthModal.tsx";
import { NameCardTray } from "./components/NameCardTray.tsx";
import { PollPanel } from "./components/PollPanel.tsx";
import { ProfileEditor } from "./components/ProfileEditor.tsx";
import { Seat } from "./components/Seat.tsx";
import {
  loadAuthSession,
  rememberInstructorSecret,
  rememberPersonSecret,
} from "./lib/authSession.ts";
import { downloadAttendanceCsv } from "./lib/attendanceExport.ts";
import { downloadStudyPlans } from "./lib/studyPlanExport.ts";
import { mergePerson, type DisplayPerson } from "./lib/people.ts";
import { useClassroomSync } from "./lib/useClassroomSync.ts";
import {
  MAX_SEATS_PER_ROW,
  MAX_STUDENT_ROWS,
  MIN_SEATS_PER_ROW,
  MIN_STUDENT_ROWS,
  isGuestId,
  occupantAt,
  seatKey,
} from "../shared/seating.ts";
import type { PersonProfile, Roster, SeatRef } from "../shared/types.ts";

const roster = rosterData as Roster;

type PendingAction =
  | { type: "place"; personId: string; target: SeatRef }
  | { type: "unseat"; personId: string }
  | { type: "edit"; personId: string }
  | { type: "reset" }
  | { type: "saveAttendance" }
  | { type: "saveStudyPlans" }
  | { type: "setLayout"; studentRowCount: number; seatsPerRow: number }
  | { type: "becomeInstructor" };

function isInstructorAction(
  action: PendingAction,
): action is Extract<PendingAction, { type: "reset" | "saveAttendance" | "saveStudyPlans" | "setLayout" | "becomeInstructor" }> {
  return action.type === "reset" || action.type === "setLayout" || action.type === "saveAttendance" ||
    action.type === "saveStudyPlans" || action.type === "becomeInstructor";
}

function matchesQuery(person: DisplayPerson, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  const haystack = [
    person.name,
    person.englishName,
    person.displayCollege,
    person.displayCountry,
    person.displayHobbies,
    person.college,
    person.country ?? "",
    person.hobbies ?? "",
    person.plan,
    person.role,
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

function byChineseName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, "zh-CN");
}

function requiresInstructorOnly(personId: string, peopleById: Record<string, DisplayPerson>): boolean {
  return peopleById[personId]?.role === "aa";
}

export default function App() {
  const sync = useClassroomSync();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const lastTapRef = useRef<{ id: string; at: number } | null>(null);

  const peopleById = useMemo(() => {
    const map: Record<string, DisplayPerson> = {};
    for (const person of roster.people) {
      map[person.id] = mergePerson(person, sync.state.profiles[person.id]);
    }
    for (const guest of sync.state.guests ?? []) {
      map[guest.id] = mergePerson(guest, sync.state.profiles[guest.id]);
    }
    return map;
  }, [sync.state.guests, sync.state.profiles]);

  const seatedIds = useMemo(() => new Set(Object.keys(sync.state.placements)), [sync.state.placements]);
  const rosterCount = roster.people.length + (sync.state.guests?.length ?? 0);
  const seatedCount = Object.keys(sync.state.placements).length;

  const unseated = useMemo(
    () =>
      Object.values(peopleById)
        .filter((person) => !seatedIds.has(person.id) && matchesQuery(person, query))
        .sort(byChineseName),
    [peopleById, query, seatedIds],
  );

  const seatedMatches = useMemo(() => {
    if (!query.trim()) {
      return [] as DisplayPerson[];
    }
    return Object.values(peopleById)
      .filter((person) => seatedIds.has(person.id) && matchesQuery(person, query))
      .sort(byChineseName);
  }, [peopleById, query, seatedIds]);

  const advisors = unseated.filter((person) => person.role === "aa");
  const peerAdvisors = unseated.filter((person) => person.role === "pa");
  const students = unseated.filter((person) => person.role === "student");
  const guestsWaiting = unseated.filter((person) => person.role === "guest");
  const selectedPerson = selectedId ? peopleById[selectedId] : undefined;
  const editingPerson = editingId ? peopleById[editingId] : undefined;
  const studyPlanMeta = sync.state.studyPlanMeta ?? {};
  const runAction = (action: PendingAction) => {
    switch (action.type) {
      case "place":
        sync.place(action.personId, action.target);
        setSelectedId(null);
        break;
      case "unseat":
        sync.unseat(action.personId);
        if (selectedId === action.personId) {
          setSelectedId(null);
        }
        break;
      case "edit":
        setEditingId(action.personId);
        break;
      case "reset":
        sync.reset();
        setSelectedId(null);
        break;
      case "saveAttendance":
        downloadAttendanceCsv(roster, sync.state, [
          ...roster.people,
          ...(sync.state.guests ?? []),
        ]);
        break;
      case "saveStudyPlans": {
        const pin = loadAuthSession().instructorSecret;
        if (!pin) {
          window.alert("Enter the instructor PIN first, then save the study plans again.");
          break;
        }
        void downloadStudyPlans(pin, roster).catch((error: unknown) => {
          window.alert(error instanceof Error ? error.message : "Could not save the study plans.");
        });
        break;
      }
      case "setLayout":
        sync.setLayout(action.studentRowCount, action.seatsPerRow);
        break;
      case "becomeInstructor":
        break;
    }
  };

  const ensureAndRun = (action: PendingAction) => {
    if (isInstructorAction(action)) {
      if (sync.isInstructor) {
        runAction(action);
        return;
      }
      setAuthError(null);
      // Defer so the opening tap does not immediately dismiss the modal on phones.
      window.setTimeout(() => setPending(action), 0);
      return;
    }

    if (sync.canControl(action.personId)) {
      runAction(action);
      return;
    }

    setAuthError(null);
    window.setTimeout(() => setPending(action), 0);
  };

  const selectPerson = (personId: string) => {
    setSelectedId((current) => (current === personId ? null : personId));
  };

  const handleSeatTap = (target: SeatRef, occupantId?: string) => {
    const now = Date.now();
    if (occupantId) {
      const last = lastTapRef.current;
      if (last && last.id === occupantId && now - last.at < 380) {
        lastTapRef.current = null;
        ensureAndRun({ type: "unseat", personId: occupantId });
        return;
      }
      lastTapRef.current = { id: occupantId, at: now };
    } else {
      lastTapRef.current = null;
    }

    if (selectedId) {
      if (occupantId === selectedId) {
        setSelectedId(null);
        return;
      }
      ensureAndRun({ type: "place", personId: selectedId, target });
      return;
    }

    if (occupantId) {
      setSelectedId(occupantId);
    }
  };

  const handleReset = () => {
    const confirmed = window.confirm("Return every name card to the side tray?");
    if (confirmed) {
      ensureAndRun({ type: "reset" });
    }
  };

  const handleSaveAttendance = () => {
    ensureAndRun({ type: "saveAttendance" });
  };

  const handleAddGuest = (name: string, pin: string) => {
    sync.addGuest(name, pin);
  };

  const workshopTasks = sync.state.workshopTasks ?? {};
  const selectedTasks = selectedId ? workshopTasks[selectedId] : undefined;

  const instructorPinOrAsk = (): string | null => {
    const pin = loadAuthSession().instructorSecret;
    if (pin) return pin;
    window.alert("Enter the instructor PIN first (Instructor PIN), then try again.");
    return null;
  };

  const handleCheckDuplicates = async () => {
    const pin = instructorPinOrAsk();
    if (!pin) return;
    try {
      const response = await fetch("/api/workshop/duplicates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instructorPin: pin }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        message?: string;
        duplicates?: Array<{ name: string; count: number }>;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.message || "Could not check duplicates.");
      }
      const rows = payload.duplicates ?? [];
      if (rows.length === 0) {
        window.alert("No duplicate display names.");
        return;
      }
      window.alert(
        rows.map((row) => `${row.name} × ${row.count}`).join("\n"),
      );
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Could not check duplicates.");
    }
  };

  const handleSurveySummary = async () => {
    const pin = instructorPinOrAsk();
    if (!pin) return;
    try {
      const response = await fetch("/api/workshop/survey-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instructorPin: pin }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        message?: string;
        summary?: {
          total: number;
          knowIdeWorkMode: Record<string, number>;
          aiFrequency: Record<string, number>;
          aiIdeFrequency: Record<string, number>;
        };
      };
      if (!response.ok || !payload.ok || !payload.summary) {
        throw new Error(payload.message || "Could not load survey summary.");
      }
      const s = payload.summary;
      const fmt = (obj: Record<string, number>) =>
        Object.entries(obj)
          .map(([k, v]) => `  ${k}: ${v}`)
          .join("\n");
      window.alert(
        [
          `Survey responses: ${s.total}`,
          "",
          "Know IDE/Work mode?",
          fmt(s.knowIdeWorkMode),
          "",
          "How often use AI?",
          fmt(s.aiFrequency),
          "",
          "How often use AI IDE/Work mode?",
          fmt(s.aiIdeFrequency),
        ].join("\n"),
      );
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Could not load survey summary.");
    }
  };

  const handleViewHtml = async () => {
    if (!selectedId) return;
    const pin = instructorPinOrAsk();
    if (!pin) return;
    try {
      const response = await fetch("/api/workshop/html/view", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instructorPin: pin, personId: selectedId }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        message?: string;
        html?: string;
        name?: string;
      };
      if (!response.ok || !payload.ok || !payload.html) {
        throw new Error(payload.message || "No HTML for that card.");
      }
      const blob = new Blob([payload.html], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Could not open HTML.");
    }
  };

  const handleRenameCard = async () => {
    if (!selectedId || !selectedPerson || selectedPerson.role !== "guest") return;
    const pin = instructorPinOrAsk();
    if (!pin) return;
    const newName = window.prompt("New display name:", selectedPerson.name);
    if (!newName || !newName.trim()) return;
    try {
      const response = await fetch("/api/workshop/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instructorPin: pin,
          personId: selectedId,
          newName: newName.trim(),
        }),
      });
      const payload = (await response.json()) as { ok?: boolean; message?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.message || "Rename failed.");
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Rename failed.");
    }
  };

  const handleRemoveGuest = (personId: string) => {
    if (!isGuestId(personId)) {
      return;
    }
    if (!sync.isInstructor) {
      window.alert("Only the instructor can delete name cards. Enter the instructor PIN first.");
      return;
    }
    const label = peopleById[personId]?.name ?? "this card";
    const confirmed = window.confirm(
      `Delete name card “${label}”? This also removes Task 1–3 submissions for that card.`,
    );
    if (confirmed) {
      sync.removeGuest(personId);
      if (selectedId === personId) {
        setSelectedId(null);
      }
      if (editingId === personId) {
        setEditingId(null);
      }
    }
  };

  const handleSaveProfile = (profile: PersonProfile) => {
    if (!editingId) {
      return;
    }
    sync.updateProfile(editingId, profile);
    setEditingId(null);
  };

  const pendingPersonId = pending && "personId" in pending ? pending.personId : null;
  const pendingPersonName =
    pending && isInstructorAction(pending)
      ? "Instructor controls"
      : pendingPersonId
        ? peopleById[pendingPersonId]?.name || "Name card"
        : "";

  const seatCount = sync.state.seatsPerRow;

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <p className="eyebrow">
            {roster.course} · {roster.section}
          </p>
          <div className="title-row">
            <h1>Vibe Coding CAT</h1>
            <a
              className="title-link"
              href="https://kwtsang101016.github.io/activities/vibecoding2026/"
              target="_blank"
              rel="noreferrer"
            >
              Workshop slides
            </a>
            <a
              className="title-link"
              href="https://kwtsang101016.github.io/activities/vibecoding2026/survey-pre/"
              target="_blank"
              rel="noreferrer"
            >
              Pre-survey
            </a>
          </div>
          <p className="subtitle">
            曾家炜 · Ka Wai Tsang · {roster.classroom}
          </p>
        </div>
        <div className="topbar__meta">
          <StatusPill
            status={sync.status}
            connectedCount={sync.connectedCount}
            sessionOpen={sync.sessionOpen}
          />
          <p className="seated-count">
            {seatedCount} / {rosterCount} seated
            {sync.isInstructor ? " · instructor" : ""}
            {sync.sessionOpen ? " · session open" : " · session closed"}
          </p>
        </div>
      </header>

      {sync.status === "idle" || sync.status === "closed" || sync.status === "offline" ? (
        <section className="session-gate" aria-label="Classroom session">
          <h2>{sync.sessionOpen ? "Reconnect to the classroom" : "Classroom session is closed"}</h2>
          <p>
            {sync.sessionOpen
              ? "You are not connected. Tap Join to sync seats with the live board."
              : "The instructor opens the session at the start of class. Students: wait, then tap Join. Instructors: Join, enter the PIN when asked, then tap Open session."}
          </p>
          <div className="session-gate__actions">
            <button type="button" className="primary-button" onClick={() => sync.join()}>
              Join classroom
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={() => {
                sync.join();
                sync.holdConnectionForAuth();
                setAuthError(null);
                window.setTimeout(() => setPending({ type: "becomeInstructor" }), 0);
              }}
            >
              Instructor: Join with PIN
            </button>
          </div>
        </section>
      ) : null}

      {sync.status === "connecting" || sync.status === "reconnecting" ? (
        <p className="howto">Connecting to the classroom…</p>
      ) : null}

      {sync.status === "live" || sync.status === "reconnecting" ? (
        <div className="session-controls" role="group" aria-label="Session controls">
          {sync.isInstructor ? (
            sync.sessionOpen ? (
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  const confirmed = window.confirm(
                    "Close the session? Everyone will be disconnected until you open it again.",
                  );
                  if (confirmed) {
                    sync.closeSession();
                  }
                }}
              >
                Close session
              </button>
            ) : (
              <button type="button" className="primary-button" onClick={() => sync.openSession()}>
                Open session
              </button>
            )
          ) : !sync.sessionOpen ? (
            <button
              type="button"
              className="ghost-button"
              onClick={() => {
                sync.holdConnectionForAuth();
                setAuthError(null);
                window.setTimeout(() => setPending({ type: "becomeInstructor" }), 0);
              }}
            >
              Instructor PIN
            </button>
          ) : null}
          <button type="button" className="ghost-button" onClick={() => sync.leave()}>
            Leave (disconnect)
          </button>
        </div>
      ) : null}


      {sync.status === "live" && sync.sessionOpen ? (
        <PollPanel
          poll={sync.poll}
          myChoice={sync.myPollChoice}
          isInstructor={sync.isInstructor}
          sessionOpen={sync.sessionOpen}
          onStart={sync.startPoll}
          onLock={sync.lockPoll}
          onClear={sync.clearPoll}
          onVote={sync.votePoll}
        />
      ) : null}

      {sync.errorMessage ? (
        <button type="button" className="banner banner--error" onClick={sync.clearError}>
          {sync.errorMessage} — tap to dismiss
        </button>
      ) : null}

      {sync.status === "live" && selectedPerson ? (
        <div className="selection-bar">
          <p>
            Selected: <strong>{selectedPerson.name}</strong> — tap an empty seat to sit
            {seatedIds.has(selectedPerson.id) ? ", or another empty seat to move" : ""}.
            {selectedTasks
              ? ` Tasks: ${selectedTasks.surveyAt ? "T1✓" : "T1·"} ${selectedTasks.htmlAt ? "T2✓" : "T2·"} ${selectedTasks.githubAt ? "T3✓" : "T3·"}`
              : ""}
            {selectedTasks?.githubUrl ? ` · ${selectedTasks.githubUrl}` : ""}
          </p>
          <div className="selection-bar__actions">
            {selectedTasks?.htmlAt && sync.isInstructor ? (
              <button type="button" className="ghost-button" onClick={() => void handleViewHtml()}>
                View HTML (T2)
              </button>
            ) : null}
            {selectedTasks?.githubUrl ? (
              <a
                className="ghost-button"
                href={selectedTasks.githubUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open GitHub (T3)
              </a>
            ) : null}
            {selectedPerson.role === "guest" && sync.isInstructor ? (
              <button type="button" className="ghost-button" onClick={() => void handleRenameCard()}>
                Rename card
              </button>
            ) : null}
            {selectedPerson.role === "guest" && sync.isInstructor ? (
              <button
                type="button"
                className="ghost-button"
                onClick={() => handleRemoveGuest(selectedPerson.id)}
              >
                Delete card
              </button>
            ) : null}
            {seatedIds.has(selectedPerson.id) ? (
              <button
                type="button"
                className="ghost-button"
                onClick={() => ensureAndRun({ type: "unseat", personId: selectedPerson.id })}
              >
                Stand up
              </button>
            ) : null}
            <button type="button" className="ghost-button" onClick={() => setSelectedId(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : sync.status === "live" ? (
        <p className="howto">
          Create a name card (name + PIN), then tap the card and a seat. Task marks: T1 survey · T2 HTML · T3 GitHub.
        </p>
      ) : null}

      {sync.status === "live" && sync.sessionOpen ? (
      <>
      <section className="controls" aria-label="Table layout">
        <label>
          Student rows
          <input
            type="number"
            min={MIN_STUDENT_ROWS}
            max={MAX_STUDENT_ROWS}
            value={sync.state.studentRowCount}
            onChange={(event) =>
              ensureAndRun({
                type: "setLayout",
                studentRowCount: Number(event.target.value),
                seatsPerRow: sync.state.seatsPerRow,
              })
            }
          />
        </label>
        <label>
          Seats per row
          <input
            type="number"
            min={MIN_SEATS_PER_ROW}
            max={MAX_SEATS_PER_ROW}
            value={sync.state.seatsPerRow}
            onChange={(event) =>
              ensureAndRun({
                type: "setLayout",
                studentRowCount: sync.state.studentRowCount,
                seatsPerRow: Number(event.target.value),
              })
            }
          />
        </label>
        <button type="button" className="ghost-button" onClick={handleReset}>
          Reset seats
        </button>
        <button type="button" className="ghost-button" onClick={handleSaveAttendance}>
          Save attendance
        </button>
        <button type="button" className="ghost-button" onClick={() => void handleCheckDuplicates()}>
          Check duplicate names
        </button>
        <button type="button" className="ghost-button" onClick={() => void handleSurveySummary()}>
          Survey summary
        </button>
      </section>

      <WorkshopSubmitPanel />

      <div className="workspace">
        <main className="hall" style={{ ["--seats-per-row" as string]: seatCount }}>
          <div className="blackboard">Front · 讲台</div>

          <ClassroomRow
            label="AA & PAs"
            hint="Academic advisor and peer advisors"
            seats={Array.from({ length: seatCount }, (_, seat) => {
              const target: SeatRef = { zone: "advisor", row: 0, seat };
              const occupantId = occupantAt(sync.state, "advisor", 0, seat);
              const occupant = occupantId ? peopleById[occupantId] : undefined;
              return (
                <Seat
                  key={seatKey("advisor", 0, seat)}
                  seatCount={seatCount}
                  occupant={occupant}
                  selected={selectedId === occupantId}
                  targetable={Boolean(selectedId) && !occupant}
                  highlighted={Boolean(occupant && query.trim() && matchesQuery(occupant, query))}
                  studyPlanSubmitted={Boolean(occupantId && studyPlanMeta[occupantId])}
                  studyPlanMajor={occupantId ? studyPlanMeta[occupantId]?.major ?? null : null}
                  workshopTasks={occupantId ? workshopTasks[occupantId] : undefined}
                  onSelect={() => handleSeatTap(target, occupantId)}
                  onDoubleUnseat={() => {
                    if (!occupantId) {
                      return;
                    }
                    ensureAndRun({ type: "unseat", personId: occupantId });
                  }}
                />
              );
            })}
          />

          <div className="aisle" aria-label="Empty row">
            <span>Empty row · 过道</span>
          </div>

          {Array.from({ length: sync.state.studentRowCount }, (_, row) => (
            <ClassroomRow
              key={row}
              label={`Row ${row + 1}`}
              hint="Students"
              seats={Array.from({ length: seatCount }, (_, seat) => {
                const target: SeatRef = { zone: "student", row, seat };
                const occupantId = occupantAt(sync.state, "student", row, seat);
                const occupant = occupantId ? peopleById[occupantId] : undefined;
                return (
                  <Seat
                    key={seatKey("student", row, seat)}
                    seatCount={seatCount}
                    occupant={occupant}
                    selected={selectedId === occupantId}
                    targetable={Boolean(selectedId) && !occupant}
                    highlighted={Boolean(occupant && query.trim() && matchesQuery(occupant, query))}
                    studyPlanSubmitted={Boolean(occupantId && studyPlanMeta[occupantId])}
                    studyPlanMajor={occupantId ? studyPlanMeta[occupantId]?.major ?? null : null}
                    workshopTasks={occupantId ? workshopTasks[occupantId] : undefined}
                    onSelect={() => handleSeatTap(target, occupantId)}
                    onDoubleUnseat={() => {
                      if (!occupantId) {
                        return;
                      }
                      ensureAndRun({ type: "unseat", personId: occupantId });
                    }}
                  />
                );
              })}
            />
          ))}
        </main>

        <NameCardTray
          advisors={advisors}
          peerAdvisors={peerAdvisors}
          students={students}
          guestsWaiting={guestsWaiting}
          seatedMatches={seatedMatches}
          query={query}
          selectedId={selectedId}
          studyPlanMeta={studyPlanMeta}
          workshopTasks={workshopTasks}
          onQueryChange={setQuery}
          onSelect={selectPerson}
          onEdit={(personId) => ensureAndRun({ type: "edit", personId })}
          onAddGuest={handleAddGuest}
          onRemoveGuest={sync.isInstructor ? handleRemoveGuest : undefined}
        />
      </div>
      </>
      ) : null}

      {editingPerson ? (
        <ProfileEditor
          person={editingPerson}
          onClose={() => setEditingId(null)}
          onSave={handleSaveProfile}
        />
      ) : null}

      {pending ? (
        <AuthModal
          personName={pendingPersonName}
          requiresInstructorOnly={
            isInstructorAction(pending) ||
            (pendingPersonId ? requiresInstructorOnly(pendingPersonId, peopleById) : false)
          }
          busy={authBusy}
          error={authError}
          onCancel={() => {
            setPending(null);
            setAuthError(null);
          }}
          onSubmit={(secret, asInstructor) => {
            void (async () => {
              setAuthBusy(true);
              setAuthError(null);
              try {
                await sync.authorize({
                  personId: pendingPersonId ?? undefined,
                  secret,
                  asInstructor,
                });
                if (asInstructor) {
                  rememberInstructorSecret(secret);
                } else if (pendingPersonId) {
                  rememberPersonSecret(pendingPersonId, secret);
                }
                const action = pending;
                setPending(null);
                if (action.type === "becomeInstructor") {
                  return;
                }
                runAction(action);
              } catch (error) {
                setAuthError(error instanceof Error ? error.message : "Verification failed.");
              } finally {
                setAuthBusy(false);
              }
            })();
          }}
        />
      ) : null}
    </div>
  );
}

function WorkshopSubmitPanel() {
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [githubUrl, setGithubUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const submitHtml = async (file: File | null) => {
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      const html = await file.text();
      const response = await fetch("/api/workshop/html", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, pin, html }),
      });
      const payload = (await response.json()) as { ok?: boolean; message?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.message || "HTML submit failed.");
      }
      setMessage("Task 2 (HTML) submitted.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "HTML submit failed.");
    } finally {
      setBusy(false);
    }
  };

  const submitGithub = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/workshop/github", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, pin, url: githubUrl }),
      });
      const payload = (await response.json()) as { ok?: boolean; message?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.message || "GitHub submit failed.");
      }
      setMessage("Task 3 (GitHub link) submitted.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "GitHub submit failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="workshop-submit"
      onSubmit={(event) => {
        event.preventDefault();
        void submitGithub();
      }}
    >
      <div className="workshop-submit__head">
        <h3>Submit Task 2 / 3</h3>
        <p>Same name + PIN as your CAT card.</p>
      </div>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={40} />
      </label>
      <label>
        PIN
        <input
          type="password"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          required
          minLength={4}
        />
      </label>
      <label>
        Task 2 · HTML
        <input
          type="file"
          accept=".html,text/html"
          disabled={busy}
          onChange={(e) => void submitHtml(e.target.files?.[0] ?? null)}
        />
      </label>
      <label className="workshop-submit__url">
        Task 3 · GitHub / Pages URL
        <input
          value={githubUrl}
          onChange={(e) => setGithubUrl(e.target.value)}
          placeholder="https://….github.io/…"
        />
      </label>
      <button type="submit" className="ghost-button" disabled={busy}>
        Submit GitHub
      </button>
      {message ? <p className="workshop-submit__msg">{message}</p> : null}
    </form>
  );
}

function ClassroomRow({
  label,
  hint,
  seats,
}: {
  label: string;
  hint: string;
  seats: ReactNode[];
}) {
  return (
    <section className="class-row">
      <div className="class-row__label">
        <strong>{label}</strong>
        <span>{hint}</span>
      </div>
      <div className="class-row__seats">{seats}</div>
    </section>
  );
}

function StatusPill({
  status,
  connectedCount,
  sessionOpen,
}: {
  status: "idle" | "connecting" | "live" | "reconnecting" | "closed" | "offline";
  connectedCount: number;
  sessionOpen: boolean;
}) {
  const label =
    status === "live"
      ? sessionOpen
        ? "Live"
        : "Connected"
      : status === "reconnecting"
        ? "Reconnecting"
        : status === "offline"
          ? "Offline"
          : status === "closed"
            ? "Closed"
            : status === "idle"
              ? "Idle"
              : "Connecting";

  return (
    <p className={`status status--${status === "closed" || status === "idle" ? "offline" : status}`}>
      <span className="status__dot" />
      {label}
      {status === "live" || status === "reconnecting" ? ` · ${connectedCount} online` : ""}
    </p>
  );
}
