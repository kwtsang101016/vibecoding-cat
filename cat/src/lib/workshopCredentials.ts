/** Browser-local name + PIN for this PC (survives refresh; not sent until task submit). */
const STORAGE_KEY = "vibecoding-cat-workshop-creds-v1";

export type WorkshopCredentials = {
  name: string;
  pin: string;
};

export function loadWorkshopCredentials(): WorkshopCredentials | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<WorkshopCredentials>;
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    const pin = typeof parsed.pin === "string" ? parsed.pin : "";
    if (!name || pin.length < 4) {
      return null;
    }
    return { name: name.slice(0, 40), pin: pin.slice(0, 32) };
  } catch {
    return null;
  }
}

export function saveWorkshopCredentials(name: string, pin: string): WorkshopCredentials | null {
  const trimmedName = name.trim().slice(0, 40);
  const trimmedPin = pin.trim().slice(0, 32);
  if (!trimmedName || trimmedPin.length < 4) {
    return null;
  }
  const credentials: WorkshopCredentials = { name: trimmedName, pin: trimmedPin };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(credentials));
  } catch {
    // Private mode / quota — ignore; tasks still work with manual entry.
  }
  return credentials;
}

export function clearWorkshopCredentials(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
