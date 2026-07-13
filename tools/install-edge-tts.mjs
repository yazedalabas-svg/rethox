import { spawnSync } from "node:child_process";

const python = process.platform === "win32" ? "python" : "python3";
const probe = spawnSync(python, ["-c", "import edge_tts"], { stdio: "ignore" });
if (probe.status === 0) process.exit(0);

const install = spawnSync(
  python,
  ["-m", "pip", "install", "--user", "--break-system-packages", "--disable-pip-version-check", "--no-cache-dir", "edge-tts==7.2.7"],
  { stdio: "inherit" },
);
if (install.status !== 0) process.exit(install.status || 1);
