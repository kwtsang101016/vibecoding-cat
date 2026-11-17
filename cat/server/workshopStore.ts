import { hashSecret, secretsMatch } from "./credentials.ts";
import type { WorkshopSurveyAnswers, WorkshopTaskMeta } from "../shared/types.ts";

const PARTICIPANTS_KEY = "vibecoding:participants";
const SURVEYS_KEY = "vibecoding:surveys";
const HTML_KEY = "vibecoding:html-submissions";
const GITHUB_KEY = "vibecoding:github-links";

const MAX_HTML_CHARS = 1_500_000;

export interface WorkshopParticipant {
  id: string;
  name: string;
  pinHash: string;
  createdAt: string;
}

export interface WorkshopSurveyRecord {
  personId: string;
  name: string;
  submittedAt: string;
  answers: WorkshopSurveyAnswers;
}

export interface WorkshopHtmlRecord {
  personId: string;
  name: string;
  submittedAt: string;
  html: string;
  byteLength: number;
}

export interface WorkshopGithubRecord {
  personId: string;
  name: string;
  submittedAt: string;
  url: string;
}

let participants: Record<string, WorkshopParticipant> = {};
let surveys: Record<string, WorkshopSurveyRecord> = {};
let htmlFiles: Record<string, WorkshopHtmlRecord> = {};
let githubLinks: Record<string, WorkshopGithubRecord> = {};

function redisConfigured(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

async function redisCommand(command: unknown[]): Promise<unknown> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Redis request failed (${response.status}): ${text}`);
  }
  const payload = (await response.json()) as { result?: unknown };
  return payload.result ?? null;
}

function pinSalt(): string {
  return (
    process.env.WORKSHOP_PIN_SALT?.trim() ||
    process.env.STUDENT_ID_SALT?.trim() ||
    "vibecoding-2026-pin-salt"
  );
}

export function workshopPinSalt(): string {
  return pinSalt();
}

async function loadMap<T>(key: string): Promise<Record<string, T>> {
  if (!redisConfigured()) return {};
  try {
    const raw = await redisCommand(["GET", key]);
    if (typeof raw !== "string" || !raw) return {};
    const parsed = JSON.parse(raw) as Record<string, T>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    console.warn(`Could not load ${key} from Redis:`, error);
    return {};
  }
}

async function saveMap(key: string, value: unknown): Promise<void> {
  if (!redisConfigured()) return;
  await redisCommand(["SET", key, JSON.stringify(value)]);
}

export async function loadWorkshopStore(): Promise<void> {
  participants = await loadMap<WorkshopParticipant>(PARTICIPANTS_KEY);
  surveys = await loadMap<WorkshopSurveyRecord>(SURVEYS_KEY);
  htmlFiles = await loadMap<WorkshopHtmlRecord>(HTML_KEY);
  githubLinks = await loadMap<WorkshopGithubRecord>(GITHUB_KEY);
  console.log(
    `Workshop store loaded: ${Object.keys(participants).length} cards, ${Object.keys(surveys).length} surveys, ${Object.keys(htmlFiles).length} HTML, ${Object.keys(githubLinks).length} GitHub links.`,
  );
}

export function listParticipants(): WorkshopParticipant[] {
  return Object.values(participants);
}

export function getParticipant(personId: string): WorkshopParticipant | undefined {
  return participants[personId];
}

export function workshopTaskMetaMap(): Record<string, WorkshopTaskMeta> {
  const meta: Record<string, WorkshopTaskMeta> = {};
  for (const id of new Set([
    ...Object.keys(surveys),
    ...Object.keys(htmlFiles),
    ...Object.keys(githubLinks),
  ])) {
    meta[id] = {
      surveyAt: surveys[id]?.submittedAt,
      htmlAt: htmlFiles[id]?.submittedAt,
      githubAt: githubLinks[id]?.submittedAt,
      githubUrl: githubLinks[id]?.url,
    };
  }
  return meta;
}

export async function registerParticipant(name: string, pin: string): Promise<WorkshopParticipant> {
  const trimmed = name.trim().slice(0, 40);
  if (!trimmed) throw new Error("Enter a display name.");
  if (!pin.trim() || pin.trim().length < 4) {
    throw new Error("Choose a PIN with at least 4 characters.");
  }
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? `guest-${crypto.randomUUID()}`
      : `guest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const participant: WorkshopParticipant = {
    id,
    name: trimmed,
    pinHash: hashSecret(pin, pinSalt()),
    createdAt: new Date().toISOString(),
  };
  participants[id] = participant;
  await saveMap(PARTICIPANTS_KEY, participants);
  return participant;
}

export function findParticipantByNamePin(name: string, pin: string): WorkshopParticipant {
  const needle = name.trim().toLowerCase();
  if (!needle) throw new Error("Enter the name on your card.");
  if (!pin.trim()) throw new Error("Enter your PIN.");
  const matches = Object.values(participants).filter((p) => p.name.toLowerCase() === needle);
  if (matches.length === 0) {
    throw new Error("No name card found with that name. Create a card in CAT first.");
  }
  const accepted = matches.filter((p) => secretsMatch(pin, p.pinHash, pinSalt()));
  if (accepted.length === 0) {
    throw new Error("PIN does not match that name card.");
  }
  if (accepted.length > 1) {
    throw new Error(
      "Multiple cards share this name and PIN. Ask the instructor to rename duplicate cards.",
    );
  }
  return accepted[0];
}

function isSurveyAnswers(value: unknown): value is WorkshopSurveyAnswers {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const freq = new Set(["Often", "Sometimes", "Seldom", "Never"]);
  return (
    (v.knowIdeWorkMode === "Y" || v.knowIdeWorkMode === "N") &&
    typeof v.aiFrequency === "string" &&
    freq.has(v.aiFrequency) &&
    typeof v.aiIdeFrequency === "string" &&
    freq.has(v.aiIdeFrequency)
  );
}

export async function saveSurvey(
  name: string,
  pin: string,
  answers: unknown,
): Promise<WorkshopSurveyRecord> {
  if (!isSurveyAnswers(answers)) {
    throw new Error("Survey answers are incomplete or invalid.");
  }
  const person = findParticipantByNamePin(name, pin);
  const record: WorkshopSurveyRecord = {
    personId: person.id,
    name: person.name,
    submittedAt: new Date().toISOString(),
    answers,
  };
  surveys[person.id] = record;
  await saveMap(SURVEYS_KEY, surveys);
  return record;
}

export async function saveHtml(
  name: string,
  pin: string,
  html: string,
): Promise<WorkshopHtmlRecord> {
  const person = findParticipantByNamePin(name, pin);
  if (typeof html !== "string" || !html.trim()) {
    throw new Error("Paste or upload an HTML file.");
  }
  if (html.length > MAX_HTML_CHARS) {
    throw new Error("HTML file is too large (max about 1.5 MB of text).");
  }
  const record: WorkshopHtmlRecord = {
    personId: person.id,
    name: person.name,
    submittedAt: new Date().toISOString(),
    html,
    byteLength: Buffer.byteLength(html, "utf8"),
  };
  htmlFiles[person.id] = record;
  await saveMap(HTML_KEY, htmlFiles);
  return record;
}

export async function saveGithub(
  name: string,
  pin: string,
  url: string,
): Promise<WorkshopGithubRecord> {
  const person = findParticipantByNamePin(name, pin);
  const trimmed = url.trim();
  if (!/^https:\/\/(www\.)?github\.com\//i.test(trimmed) && !/^https:\/\/[\w.-]+\.github\.io\//i.test(trimmed)) {
    throw new Error("Enter a GitHub repo or GitHub Pages https URL.");
  }
  const record: WorkshopGithubRecord = {
    personId: person.id,
    name: person.name,
    submittedAt: new Date().toISOString(),
    url: trimmed,
  };
  githubLinks[person.id] = record;
  await saveMap(GITHUB_KEY, githubLinks);
  return record;
}

export function getHtml(personId: string): WorkshopHtmlRecord | undefined {
  return htmlFiles[personId];
}

export function getGithub(personId: string): WorkshopGithubRecord | undefined {
  return githubLinks[personId];
}

export function duplicateNames(): Array<{ name: string; count: number; ids: string[] }> {
  const buckets = new Map<string, WorkshopParticipant[]>();
  for (const p of Object.values(participants)) {
    const key = p.name.trim().toLowerCase();
    const list = buckets.get(key) ?? [];
    list.push(p);
    buckets.set(key, list);
  }
  return [...buckets.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([, list]) => ({
      name: list[0].name,
      count: list.length,
      ids: list.map((p) => p.id),
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function surveySummary(): {
  total: number;
  knowIdeWorkMode: Record<"Y" | "N", number>;
  aiFrequency: Record<string, number>;
  aiIdeFrequency: Record<string, number>;
} {
  const knowIdeWorkMode = { Y: 0, N: 0 };
  const aiFrequency: Record<string, number> = {
    Often: 0,
    Sometimes: 0,
    Seldom: 0,
    Never: 0,
  };
  const aiIdeFrequency: Record<string, number> = {
    Often: 0,
    Sometimes: 0,
    Seldom: 0,
    Never: 0,
  };
  const rows = Object.values(surveys);
  for (const row of rows) {
    knowIdeWorkMode[row.answers.knowIdeWorkMode] += 1;
    aiFrequency[row.answers.aiFrequency] =
      (aiFrequency[row.answers.aiFrequency] ?? 0) + 1;
    aiIdeFrequency[row.answers.aiIdeFrequency] =
      (aiIdeFrequency[row.answers.aiIdeFrequency] ?? 0) + 1;
  }
  return { total: rows.length, knowIdeWorkMode, aiFrequency, aiIdeFrequency };
}

export async function deleteParticipant(personId: string): Promise<void> {
  if (!participants[personId]) {
    // Still allow clearing orphan tray cards with no workshop record.
    delete surveys[personId];
    delete htmlFiles[personId];
    delete githubLinks[personId];
    await Promise.all([
      saveMap(SURVEYS_KEY, surveys),
      saveMap(HTML_KEY, htmlFiles),
      saveMap(GITHUB_KEY, githubLinks),
    ]);
    return;
  }
  delete participants[personId];
  delete surveys[personId];
  delete htmlFiles[personId];
  delete githubLinks[personId];
  await Promise.all([
    saveMap(PARTICIPANTS_KEY, participants),
    saveMap(SURVEYS_KEY, surveys),
    saveMap(HTML_KEY, htmlFiles),
    saveMap(GITHUB_KEY, githubLinks),
  ]);
}

export async function renameParticipant(
  personId: string,
  newName: string,
): Promise<WorkshopParticipant> {
  const person = participants[personId];
  if (!person) throw new Error("Unknown name card.");
  const trimmed = newName.trim().slice(0, 40);
  if (!trimmed) throw new Error("Enter a new display name.");
  person.name = trimmed;
  participants[personId] = person;
  await saveMap(PARTICIPANTS_KEY, participants);
  if (surveys[personId]) {
    surveys[personId] = { ...surveys[personId], name: trimmed };
    await saveMap(SURVEYS_KEY, surveys);
  }
  if (htmlFiles[personId]) {
    htmlFiles[personId] = { ...htmlFiles[personId], name: trimmed };
    await saveMap(HTML_KEY, htmlFiles);
  }
  if (githubLinks[personId]) {
    githubLinks[personId] = { ...githubLinks[personId], name: trimmed };
    await saveMap(GITHUB_KEY, githubLinks);
  }
  return person;
}
