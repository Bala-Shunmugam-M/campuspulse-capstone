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

/**
 * The policy library every institution starts with. Part of the world, so it is
 * seeded rather than simulated (spec 8.1): a policy is a fixture people act
 * against, not an event. Acknowledging one is the event, and the simulator
 * produces those.
 */
export const POLICIES = [
  {
    code: "ACAD-01",
    title: "Academic Integrity",
    ownerDepartment: "Student Affairs",
    summary: "What counts as academic misconduct and how it is handled.",
    body: `## Scope

This policy applies to every assessed submission, in every programme.

## Prohibited conduct

- Presenting another person's work, in whole or in part, as your own.
- Collaborating on an assessment declared as individual work.
- Fabricating data, citations or experimental results.
- Arranging for a third party to complete assessed work.

## Procedure

1. A suspected breach is reported to the module leader.
2. The module leader refers the matter to the compliance office within five working days.
3. The student is invited to respond in writing before any finding is recorded.

A finding of misconduct is recorded against the assessment, not against the student's
record as a whole, unless the panel directs otherwise.`,
  },
  {
    code: "CONDUCT-01",
    title: "Code of Conduct",
    ownerDepartment: "Student Affairs",
    summary: "The standard of behaviour expected across the campus community.",
    body: `## Principles

Members of this community treat one another with respect, and act so that others
can study and work without intimidation.

## Expectations

- Address disagreement through argument rather than through pressure.
- Respect the privacy of others, including material shared in confidence.
- Follow reasonable instructions from staff acting in their role.

> Behaviour that would be unacceptable in person is equally unacceptable online.

## Reporting

Any member of the community may report a concern, anonymously if they prefer. A
report made in good faith attracts no penalty even if it is not upheld.`,
  },
  {
    code: "DATA-01",
    title: "Data Protection",
    ownerDepartment: "Library Services",
    summary: "How personal data is collected, held and disclosed.",
    body: `## Lawful basis

Personal data is collected only where there is a lawful basis to do so, and only
for the purpose stated at the point of collection.

## Retention

- Case records are retained for seven years after closure.
- Reporter contact details are retained only while a case is open.
- Access logs are retained for eighteen months.

## Disclosure

Personal data is disclosed outside the institution only under a legal obligation,
and every such disclosure is recorded in the audit log.`,
  },
  {
    code: "RES-01",
    title: "Residence Conduct",
    ownerDepartment: "Facilities",
    summary: "Living standards and obligations in university residences.",
    body: `## Quiet hours

Quiet hours run from 22:00 to 07:00 on every night of the week. During assessment
periods they begin at 20:00.

## Safety

- Fire doors are never to be propped open.
- Corridors and stairwells are kept clear of personal property.
- Cooking appliances are used only in designated kitchens.

## Guests

Residents are responsible for the conduct of their guests, including any damage
caused during a visit.`,
  },
  {
    code: "SUBST-01",
    title: "Substance Policy",
    ownerDepartment: "Student Affairs",
    summary: "Alcohol and controlled substances on university premises.",
    body: `## Alcohol

Alcohol may be consumed only in licensed areas and at sanctioned events. Supplying
alcohol to a person under the legal drinking age is a disciplinary matter.

## Controlled substances

The possession, use or supply of controlled substances on university premises is
prohibited and will be reported to the relevant authorities.

## Support

A student who seeks help with substance dependence will be offered support. Seeking
help is not itself treated as a disciplinary matter.`,
  },
  {
    code: "IT-01",
    title: "Acceptable Use of IT",
    ownerDepartment: "Computer Science",
    summary: "Acceptable use of university networks, accounts and devices.",
    body: `## Accounts

Your account is yours alone. Sharing credentials is a breach of this policy even
where no harm follows.

## Networks

- Do not attempt to circumvent access controls or monitoring.
- Do not scan or probe university systems without written authorisation.
- Report a suspected compromise immediately; concealing one is the serious offence.

## Devices

Personal devices connected to university networks must carry current security
updates.`,
  },
] as const;

/** Password for every seeded account. Development only; all accounts must change it. */
export const SEED_PASSWORD = "capstone demo passphrase";
