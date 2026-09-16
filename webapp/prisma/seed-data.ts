export const INSTITUTIONS = [
  { name: "Northgate University", code: "NGU", domain: "northgate.edu", city: "Chennai" },
  { name: "Riverside Institute of Technology", code: "RIT", domain: "riverside.edu", city: "Pune" },
  { name: "Westfield College", code: "WFC", domain: "westfield.edu", city: "Kochi" },
] as const;

export const DEPARTMENTS = [
  "Computer Science", "Mechanical Engineering", "Business Studies",
  "Student Affairs", "Facilities", "Library Services",
] as const;

export const CATEGORIES = [
  { name: "Academic misconduct", slaHours: 72 },
  { name: "Harassment", slaHours: 24 },
  { name: "Property damage", slaHours: 168 },
  { name: "Substance policy", slaHours: 72 },
  { name: "Residence conduct", slaHours: 168 },
  { name: "Data protection", slaHours: 24 },
] as const;

/** Password for every seeded account. Development only; all accounts must change it. */
export const SEED_PASSWORD = "capstone demo passphrase";
