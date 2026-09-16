import type { ComplianceRole } from "@prisma/client";
import { prisma } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth/password";
import { CATEGORIES, DEPARTMENTS, INSTITUTIONS, SEED_PASSWORD } from "./seed-data";

const ROLE_MIX: { role: ComplianceRole; count: number }[] = [
  { role: "admin", count: 1 },
  { role: "dpo", count: 1 },
  { role: "officer", count: 3 },
  { role: "investigator", count: 4 },
  { role: "reporter", count: 31 },
];

async function main() {
  const passwordHash = await hashPassword(SEED_PASSWORD);

  for (const inst of INSTITUTIONS) {
    const [institution] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO campuspulse.institutions (name, code, domain, city, timezone, is_active)
      VALUES (${inst.name}, ${inst.code}, ${inst.domain}, ${inst.city}, 'Asia/Kolkata', true)
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
      RETURNING id`;

    for (const category of CATEGORIES) {
      await prisma.$executeRaw`
        INSERT INTO campuspulse.categories (institution_id, name, category_type, sla_hours)
        SELECT ${institution.id}::uuid, ${category.name}, 'issue_category', ${category.slaHours}
        WHERE NOT EXISTS (
          SELECT 1 FROM campuspulse.categories
          WHERE institution_id = ${institution.id}::uuid AND name = ${category.name})`;
    }

    const campusRows = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO campuspulse.locations (institution_id, name, location_type, code)
      SELECT ${institution.id}::uuid, ${`${inst.name} Main Campus`}, 'campus', ${inst.code}
      WHERE NOT EXISTS (
        SELECT 1 FROM campuspulse.locations
        WHERE institution_id = ${institution.id}::uuid AND location_type = 'campus')
      RETURNING id`;

    if (campusRows.length > 0) {
      for (const building of ["Science Block", "Library", "Hostel A", "Admin Building"]) {
        await prisma.$executeRaw`
          INSERT INTO campuspulse.locations (institution_id, parent_id, name, location_type)
          VALUES (${institution.id}::uuid, ${campusRows[0].id}::uuid, ${building}, 'building')`;
      }
    }

    let index = 0;
    for (const { role, count } of ROLE_MIX) {
      for (let i = 0; i < count; i++) {
        index += 1;
        const email = `${role}${i + 1}@${inst.domain}`;
        const fullName = `${role[0].toUpperCase()}${role.slice(1)} ${i + 1}`;
        const department = DEPARTMENTS[index % DEPARTMENTS.length];

        const [user] = await prisma.$queryRaw<{ id: string }[]>`
          INSERT INTO campuspulse.users (institution_id, full_name, email, department, is_active)
          VALUES (${institution.id}::uuid, ${fullName}, ${email}, ${department}, true)
          ON CONFLICT (institution_id, email) DO UPDATE SET full_name = EXCLUDED.full_name
          RETURNING id`;

        const account = await prisma.userAccount.upsert({
          where: { userId: user.id },
          create: {
            userId: user.id,
            institutionId: institution.id,
            email,
            passwordHash,
            mustChangePassword: true,
          },
          update: {},
        });

        const live = await prisma.roleAssignment.findFirst({
          where: { userAccountId: account.id, role, revokedAt: null },
        });
        if (!live) {
          await prisma.roleAssignment.create({ data: { userAccountId: account.id, role } });
        }
      }
    }
  }

  const [institutions, accounts, grants] = await Promise.all([
    prisma.institution.count(),
    prisma.userAccount.count(),
    prisma.roleAssignment.count({ where: { revokedAt: null } }),
  ]);
  console.log(`institutions ${institutions}  accounts ${accounts}  live role grants ${grants}`);
  console.log(`\nSign in as  admin1@northgate.edu  /  ${SEED_PASSWORD}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
