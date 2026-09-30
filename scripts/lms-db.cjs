// Test helper: seed and inspect the LMS's class-recording rows in the THROWAWAY local database.
// Uses the LMS worktree's own Prisma client, so the schema is the real one.
//
//   node scripts/lms-db.cjs init
//   node scripts/lms-db.cjs seedrec <jobId> <objectKey> <roomName>
//   node scripts/lms-db.cjs show <jobId>
//
// Refuses to run against anything but a local database.
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const LMS = process.env.LMS_DIR || "C:/Users/HP/Documents/easyway-lms-worktrees/own-recorder/prototype";
for (const line of fs.readFileSync(path.join(LMS, ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
if (!/@(127\.0\.0\.1|localhost):5433\/recorder_test/.test(process.env.DATABASE_URL || "")) {
  console.error("REFUSING: DATABASE_URL is not the local recorder_test database");
  process.exit(2);
}

const { PrismaClient } = createRequire(path.join(LMS, "package.json"))("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  if (cmd === "init") {
    const tenant = (await prisma.tenant.findUnique({ where: { slug: "recorder-test" } })) ?? (await prisma.tenant.create({ data: { name: "Recorder Test School", slug: "recorder-test" } }));
    console.log(JSON.stringify({ tenantId: tenant.id }));
  } else if (cmd === "seedrec") {
    const [jobId, objectKey, roomName] = args;
    const tenant = await prisma.tenant.findUnique({ where: { slug: "recorder-test" } });
    const row = await prisma.classRecording.create({
      data: {
        egressId: `rec_${jobId}`, roomName, tenantId: tenant.id, level: "a1", sessionSlot: "morning",
        status: "active", variant: "video", objectKey,
      },
    });
    console.log(JSON.stringify({ id: row.id, egressId: row.egressId }));
  } else if (cmd === "show") {
    const row = await prisma.classRecording.findUnique({ where: { egressId: `rec_${args[0]}` } });
    const material = row?.materialId ? await prisma.material.findUnique({ where: { id: row.materialId } }) : null;
    console.log(JSON.stringify({
      recording: row && { status: row.status, error: row.error, durationSeconds: row.durationSeconds, sizeBytes: row.sizeBytes, objectKey: row.objectKey, fileUrl: row.fileUrl, materialId: row.materialId, studentExpiresAt: row.studentExpiresAt },
      material: material && { title: material.title, kind: material.kind, level: material.level, filePath: material.filePath, fileType: material.fileType, fileSize: material.fileSize, durationSeconds: material.durationSeconds, thumbnailPath: material.thumbnailPath },
    }));
  } else {
    console.error("unknown command");
    process.exit(1);
  }
}

main().catch((e) => { console.error(String(e).slice(0, 600)); process.exit(1); }).finally(() => prisma.$disconnect());
