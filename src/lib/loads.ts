import "server-only";

// Demo data for one owner-operator. Times are set relative to server start so
// the detention clock is always running when a judge opens the demo. Brokers
// and the lumper are PayPal sandbox accounts, never real companies.
export type Load = {
  id: string;
  broker: string;
  brokerEmail: string;
  receiver: string;
  city: string;
  appointment: string; // ISO
  arrived: string | null; // ISO, from the truck's geofence
  released: string | null; // ISO, null while still at the dock
  freeHours: number; // detention starts after this, per the rate confirmation
  ratePerHour: number;
  invoiceId?: string;
  invoiceStatus?: string;
  lumper?: { amount: string; batchId: string; status: string; at: string };
};

const HOUR = 3600_000;
const start = Date.now();
const at = (hoursFromStart: number) => new Date(start + hoursFromStart * HOUR).toISOString();

const broker = () => process.env.PAYPAL_BROKER_EMAIL ?? "";

// Created lazily so env is read at request time, not at build time.
let loads: Load[] | null = null;
export function allLoads(): Load[] {
  return (loads ??= [
    {
      id: "DT-1042",
      broker: "Lakeshore Freight Brokerage (demo)",
      brokerEmail: broker(),
      receiver: "Cold storage DC, dock 14",
      city: "Columbus, OH",
      appointment: at(-4),
      arrived: at(-4.9),
      released: null,
      freeHours: 2,
      ratePerHour: 75,
    },
    {
      id: "DT-1039",
      broker: "Prairie Logistics (demo)",
      brokerEmail: broker(),
      receiver: "Grocery DC, door 6",
      city: "Indianapolis, IN",
      appointment: at(-29),
      arrived: at(-29.25),
      released: at(-24.5),
      freeHours: 2,
      ratePerHour: 60,
    },
    {
      id: "DT-1047",
      broker: "Lakeshore Freight Brokerage (demo)",
      brokerEmail: broker(),
      receiver: "Paper mill, shipping office",
      city: "Toledo, OH",
      appointment: at(20),
      arrived: null,
      released: null,
      freeHours: 2,
      ratePerHour: 75,
    },
  ]);
}

export const findLoad = (id: string) => allLoads().find((l) => l.id.toLowerCase() === id.trim().toLowerCase());

export type Detention = {
  clockStart: string;
  end: string;
  stillAtDock: boolean;
  onSiteMinutes: number;
  freeMinutes: number;
  billableMinutes: number;
  billableHours: string; // two decimals, as invoiced
  amount: string;
};

// The detention clock starts at the appointment time, or at arrival if the
// truck arrived late. Free time comes off first; the rest is billed per hour,
// rounded to the minute.
export function detention(load: Load, now = Date.now()): Detention | null {
  if (!load.arrived) return null;
  const clockStart = Math.max(Date.parse(load.arrived), Date.parse(load.appointment));
  const end = load.released ? Date.parse(load.released) : now;
  const onSite = Math.max(0, Math.round((end - clockStart) / 60_000));
  const free = load.freeHours * 60;
  const billable = Math.max(0, onSite - free);
  const hours = (billable / 60).toFixed(2);
  return {
    clockStart: new Date(clockStart).toISOString(),
    end: new Date(end).toISOString(),
    stillAtDock: !load.released,
    onSiteMinutes: onSite,
    freeMinutes: free,
    billableMinutes: billable,
    billableHours: hours,
    amount: (Number(hours) * load.ratePerHour).toFixed(2),
  };
}

// The demo loads are all in the Eastern time zone.
export const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET";
