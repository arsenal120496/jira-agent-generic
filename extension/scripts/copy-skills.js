// Copy the two skills from the repo root (../skills) into extension/skills so `vsce package`
// includes them in the VSIX. Runs from `vscode:prepublish`, so a plain `vsce package` (or the
// bundle build) always ships the skills. The copied folder is generated output, not source.
const fs = require('fs');
const path = require('path');

const ext = path.resolve(__dirname, '..');       // .../extension
const root = path.resolve(ext, '..');             // .../jira-agent-generic
const src = path.join(root, 'skills');
const dest = path.join(ext, 'skills');

if (!fs.existsSync(src)) {
    console.error(`copy-skills: source not found: ${src}`);
    process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
for (const s of ['jira-poller', 'implement-task']) {
    const from = path.join(src, s);
    if (!fs.existsSync(from)) { console.error(`copy-skills: missing skill ${from}`); process.exit(1); }
    fs.cpSync(from, path.join(dest, s), { recursive: true });
    console.log(`copy-skills: staged ${s}`);
}
