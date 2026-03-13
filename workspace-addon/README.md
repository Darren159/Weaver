# PKM Linker — Google Workspace Add-on

Google Docs sidebar add-on that provides AI-powered completions and contextual document search, backed by the PKM Linker backend. Built with Google Apps Script (TypeScript via clasp).

---

## Structure

```
src/
  appsscript.json   Add-on manifest and OAuth scopes
  Code.ts           Server-side Apps Script — cursor context, text insertion, Drive indexing
  sidebar.html      Sidebar UI — streaming completions, related docs, settings
.clasp.json         Clasp config (set your scriptId here)
package.json
tsconfig.json
```

---

## How It Works

**Architecture:**
- `Code.ts` runs on Google's servers. It reads cursor context using `DocumentApp`, inserts text, and indexes Drive docs server-side using `UrlFetchApp`.
- `sidebar.html` runs in the user's browser (sandboxed iframe). It calls `Code.ts` functions via `google.script.run` and streams completions directly from the backend using the Fetch API.

**Completion flow:**
1. User clicks **Get Completion** in the sidebar
2. `getCursorContext()` (server-side) reads the 2000 chars of text before the cursor and 500 chars after
3. The sidebar POSTs to `/api/complete` and streams tokens as they arrive
4. The suggestion appears in the sidebar — click **Insert** to append it at the cursor

**Drive indexing:**
- Click **Index this folder** to index all Google Docs in the same Drive folder as the current document
- `indexFolder()` (server-side) reads each doc via `DocumentApp`, chunks it into ~1500-char pieces, and POSTs to `/api/ingest`
- Indexed docs become context for future completions and related-doc search

---

## Setup

### Prerequisites
- Node.js 18+
- A Google account
- The backend running (see root README)

### 1. Install clasp

```bash
cd workspace-addon
npm install
```

### 2. Log in to Google

```bash
npx clasp login
```

This opens a browser to authorize clasp with your Google account.

### 3. Create the Apps Script project

**Option A — New script (easiest):**
```bash
npx clasp create --type docs --title "PKM Linker"
```
This creates a new standalone script and writes the `scriptId` to `.clasp.json` automatically.

**Option B — Existing script:**
Open [script.google.com](https://script.google.com), open your project, go to **Project Settings → Script ID**, and paste it into `.clasp.json`:
```json
{ "scriptId": "YOUR_SCRIPT_ID", "rootDir": "src" }
```

### 4. Push the code

```bash
npm run push
```

clasp compiles the TypeScript and uploads all files in `src/` to Apps Script.

### 5. Open in Google Docs

1. Open any Google Doc
2. Click **Extensions** → **PKM Linker** → **Open sidebar**
   - If you don't see the menu, reload the page — the `onOpen` trigger adds it on document load
3. In the sidebar settings, set your **Backend URL** (default: `http://localhost:3000`)
4. Click **Index this folder** to index the Drive docs you want as context

---

## Development Workflow

```bash
npm run watch    # auto-push on file save
npm run open     # open the script in Apps Script editor
```

TypeScript type checking (no compilation — clasp handles that):
```bash
npx tsc --noEmit
```

---

## Deploying for Your Team

To share with teammates:
1. In the Apps Script editor: **Deploy** → **New deployment** → Type: **Add-on**
2. Share the deployment link, or publish to the [Google Workspace Marketplace](https://workspace.google.com/marketplace)

For marketplace publishing you'll need a Google Cloud project with the Apps Script API enabled and a verified publisher account.

---

## Limitations

- **HTTPS required in production**: The sidebar iframe is served over HTTPS, so the backend must also be HTTPS (e.g. behind a reverse proxy with TLS). For local development, Chrome allows HTTP requests to `localhost` from HTTPS contexts.
- **Cursor detection**: `getSurroundingText()` returns only the current paragraph's text. Context is built by finding its position in the full document body — this is reliable for most cases but may be slightly off in documents with many identical paragraph texts.
- **No automatic triggering**: Unlike the VS Code extension, completions are triggered manually via the **Get Completion** button. Apps Script doesn't provide document keystroke events to sidebar code.
