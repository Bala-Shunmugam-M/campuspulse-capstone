import type { Faker } from "@faker-js/faker";
import type { Rng } from "./distributions";

/**
 * Free text, composed rather than picked.
 *
 * A handful of repeated strings would make every full-text search in the
 * application either match everything or nothing, and would tell a reader
 * looking at the data nothing about how people actually write. These compose
 * templated fragments with Faker, seeded from the same seed as everything else,
 * so descriptions and notes vary in length and register and a run stays
 * reproducible.
 */

export type Register = "terse" | "plain" | "anxious" | "formal";

const SUBJECTS = [
  "a group of students",
  "someone from another department",
  "a visitor without a pass",
  "two people I did not recognise",
  "a member of staff",
  "a contractor working in the corridor",
  "somebody on the floor above",
];

const INCIDENTS = [
  "were shouting at each other in a way that felt like it was about to escalate",
  "had propped the fire door open with a chair",
  "were copying from a phone during the assessment",
  "left equipment running unattended for most of the afternoon",
  "were drinking in a part of the building where that is not allowed",
  "kept following me between buildings",
  "took photographs of people who had not agreed to it",
  "damaged a noticeboard and walked off",
  "were using another person's access card",
  "posted something about a classmate that was clearly meant to humiliate them",
];

const PLACES = [
  "outside the Science Block",
  "in the second-floor corridor of the Library",
  "near the Hostel A entrance",
  "in the Admin Building stairwell",
  "by the bike racks",
  "in the studio on the lower ground floor",
  "at the back of the lecture theatre",
];

const CONSEQUENCES = [
  "Nobody was hurt, but it left several people shaken.",
  "I am worried it will happen again at the same time next week.",
  "Two other people saw it and can say the same.",
  "I did not feel able to say anything at the time.",
  "It has been going on for a few weeks now and is getting worse.",
  "I have kept a photograph of the damage.",
  "I would rather not be named when this is looked into.",
];

const OPENERS: Record<Register, string[]> = {
  terse: ["", "", "Reporting this. "],
  plain: ["I want to report that ", "This morning ", "Earlier today "],
  anxious: [
    "I am not sure if this is the right place for this, but ",
    "I have been putting off saying anything. ",
    "Please treat this carefully. ",
  ],
  formal: [
    "I wish to formally report the following. ",
    "For the record: ",
    "Submitting this in line with the reporting policy. ",
  ],
};

const TITLE_SHAPES = [
  (_subject: string, place: string) => `Disturbance ${place}`,
  (subject: string, place: string) => `Concern about ${subject} ${place}`,
  (_subject: string, place: string) => `Incident ${place}`,
  (_subject: string, place: string) => `Repeated problem ${place}`,
  (subject: string, place: string) => `${subject} ${place}`,
];

function capitalise(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}

export function reportTitle(rng: Rng): string {
  const shape = rng.pick(TITLE_SHAPES);
  return capitalise(shape(rng.pick(SUBJECTS), rng.pick(PLACES))).slice(0, 120);
}

/**
 * A description of varying length and register. Long enough to clear the
 * validator's minimum, and often a good deal longer, because real reports are
 * not all the same size.
 */
export function reportDescription(rng: Rng, faker: Faker, register: Register): string {
  const opener = rng.pick(OPENERS[register]);
  const core = `${rng.pick(SUBJECTS)} ${rng.pick(INCIDENTS)} ${rng.pick(PLACES)}`;

  const sentences = [`${opener}${opener === "" ? capitalise(core) : core}.`];

  if (register !== "terse") sentences.push(rng.pick(CONSEQUENCES));

  if (rng.bool(0.45)) {
    sentences.push(
      `It happened at about ${String(rng.int(8, 21)).padStart(2, "0")}:${String(
        rng.int(0, 59),
      ).padStart(2, "0")}.`,
    );
  }

  if (rng.bool(0.3)) {
    sentences.push(`${faker.person.firstName()} was with me and saw the same thing.`);
  }

  if (register === "formal" && rng.bool(0.5)) {
    sentences.push("I would like to be told what happens next and whether any action is taken.");
  }

  if (rng.bool(0.25)) sentences.push(faker.lorem.sentence({ min: 8, max: 18 }));

  const text = sentences.join(" ");
  // The validator sets a floor; pad only when a terse draw lands under it.
  return text.length >= 40 ? text : `${text} ${faker.lorem.sentence({ min: 10, max: 16 })}`;
}

export function followUpStatement(rng: Rng, faker: Faker): string {
  const openings = [
    "Adding to what I reported earlier. ",
    "Following up on this. ",
    "One more thing I remembered. ",
  ];
  const additions = [
    "It happened again yesterday, in the same place.",
    "I have since spoken to someone in my department about it.",
    "Another person has told me they saw it too.",
    "Nothing further has happened since, but I wanted it on record.",
    "I have the name of one of the people involved now.",
  ];
  return `${rng.pick(openings)}${rng.pick(additions)} ${faker.lorem.sentence({
    min: 6,
    max: 14,
  })}`;
}

const NOTE_SHAPES = {
  internal: [
    "Triaged. Nothing here suggests a safeguarding concern; handling as a conduct matter.",
    "Checked the access logs for the window given. Nothing conclusive either way.",
    "Spoke to the duty officer. No previous reports against this location this term.",
    "Holding pending the respondent's written response.",
    "Reassigning: this overlaps with a case I am already conflicted on.",
  ],
  shared_with_parties: [
    "A meeting has been arranged for both parties later this week.",
    "Both parties have been sent the procedure and the expected timeline.",
    "The respondent has been given until the end of the week to reply in writing.",
    "An adviser has been offered to both parties.",
  ],
  reporter_visible: [
    "Thank you for reporting this. It has been assigned and is being looked into.",
    "We have spoken to the people involved and will update you once a decision is reached.",
    "This is taking longer than we hoped because we are waiting on a written response.",
    "A decision has been reached and will be recorded shortly.",
  ],
} as const;

export function noteBody(rng: Rng, faker: Faker, visibility: keyof typeof NOTE_SHAPES): string {
  const base = rng.pick(NOTE_SHAPES[visibility]);
  if (rng.bool(0.4)) return `${base} ${faker.lorem.sentence({ min: 6, max: 16 })}`;
  return base;
}

const RATIONALES: Record<string, string[]> = {
  upheld: [
    "The account was corroborated by two independent witnesses and by the access log.",
    "The respondent accepted the substance of the report in their written response.",
  ],
  partially_upheld: [
    "The central allegation is made out; the secondary one is not supported by the evidence.",
    "The conduct occurred, but not with the intent the report describes.",
  ],
  not_upheld: [
    "The evidence does not support the allegation, and the witness accounts conflict on the essentials.",
    "The behaviour described falls short of a breach of the policy as written.",
  ],
  inconclusive: [
    "Neither account can be preferred on the material available, and no further evidence is obtainable.",
    "The only witness has declined to give a statement, and nothing else corroborates either side.",
  ],
};

export function outcomeRationale(rng: Rng, faker: Faker, finding: string): string {
  const base = rng.pick(RATIONALES[finding] ?? RATIONALES.inconclusive);
  return rng.bool(0.5) ? `${base} ${faker.lorem.sentence({ min: 8, max: 18 })}` : base;
}

/** Evidence bytes: a small text file, so uploads carry real content. */
export function evidenceFile(rng: Rng, faker: Faker): { name: string; bytes: Buffer } {
  const lines = [
    `Statement recorded ${faker.date.past().toISOString().slice(0, 10)}`,
    "",
    faker.lorem.paragraph({ min: 3, max: 6 }),
    "",
    `Taken by: ${faker.person.fullName()}`,
  ];
  const kind = rng.pick(["statement", "log-extract", "photo-description", "correspondence"]);
  return {
    name: `${kind}-${faker.string.alphanumeric(6).toLowerCase()}.txt`,
    bytes: Buffer.from(lines.join("\n"), "utf8"),
  };
}
