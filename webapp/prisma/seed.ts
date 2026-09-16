import { prisma } from "../src/lib/db";

async function main() {
  await prisma.$executeRaw`
    INSERT INTO campuspulse.institutions (name, code, domain, city, timezone, is_active)
    VALUES ('Northgate University', 'NGU', 'northgate.edu', 'Chennai', 'Asia/Kolkata', true)
    ON CONFLICT (code) DO NOTHING`;
  console.log(`institutions: ${await prisma.institution.count()}`);
}

main().finally(() => prisma.$disconnect());
