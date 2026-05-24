/* ============================================================
   England Over 40s Cricket — YouTube Status Updater (backend)
   ------------------------------------------------------------
   Netlify serverless function.

   The GitHub token is held HERE, server-side, as the environment
   variable GITHUB_TOKEN, and is never sent to the browser. The
   admin tool sends only the PIN, which this function checks
   against the ADMIN_PIN environment variable.

   Required environment variables
   (Netlify -> Site configuration -> Environment variables):

     GITHUB_TOKEN  Fine-grained Personal Access Token, scoped to
                   the single repository Eng40sCricket/eng40s-website,
                   with Repository permission "Contents: Read and write".

     ADMIN_PIN     The admin PIN for unlocking the tool.

   Actions handled (POST, JSON body):
     { action: "load", pin }                 -> { matches: [...] }
     { action: "save", pin, title, status }  -> { ok: true }
   ============================================================ */

const GH_API = 'https://api.github.com';
const OWNER  = 'Eng40sCricket';
const REPO   = 'eng40s-website';
const BRANCH = 'main';
const FILE   = 'media/index.html';

function json(statusCode, obj) {
  return {
    statusCode: statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj)
  };
}

/* Pull the MATCHES array out of the Media Hub page and parse it.
   Values in that file are quoted with either ' or " (double quotes
   are used where a value contains an apostrophe), so the field
   reader below accepts both. */
function parseMatches(content) {
  const start = content.indexOf('const MATCHES = [');
  if (start === -1) return [];
  const end = content.indexOf('];', start) + 2;
  const block = content.slice(start, end);

  const matches = [];
  const objectRe = /\{([^}]+)\}/g;
  let m;
  while ((m = objectRe.exec(block)) !== null) {
    const obj = m[1];
    const get = function (key) {
      const r = new RegExp(key + "\\s*:\\s*(['\"])(.*?)\\1");
      const found = r.exec(obj);
      return found ? found[2] : '';
    };
    matches.push({
      title:   get('title'),
      date:    get('date'),
      venue:   get('venue'),
      videoId: get('videoId'),
      status:  get('status')
    });
  }
  return matches;
}

/* Change one match's status within the page content. Matches the
   match object by title (single- or double-quoted) and rewrites
   only its status value. Returns the content unchanged if the
   match is not found. */
function updateMatchStatus(content, matchTitle, newStatus) {
  const escaped = matchTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    "(title:\\s*(['\"])" + escaped + "\\2[\\s\\S]*?status:\\s*)'(upcoming|live|replay)'"
  );
  return content.replace(re, "$1'" + newStatus + "'");
}

async function ghGetFile(token) {
  const url = GH_API + '/repos/' + OWNER + '/' + REPO + '/contents/' + FILE + '?ref=' + BRANCH;
  const res = await fetch(url, {
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'eo40s-yt-admin'
    }
  });
  if (!res.ok) throw new Error('GitHub read failed (' + res.status + ').');
  const data = await res.json();
  const b64 = (data.content || '').replace(/\n/g, '');
  const content = Buffer.from(b64, 'base64').toString('utf-8');
  return { sha: data.sha, content: content };
}

async function ghPutFile(token, content, sha, message) {
  const url = GH_API + '/repos/' + OWNER + '/' + REPO + '/contents/' + FILE;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'eo40s-yt-admin',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: message,
      content: Buffer.from(content, 'utf-8').toString('base64'),
      sha: sha,
      branch: BRANCH
    })
  });
  if (!res.ok) {
    let detail = '';
    try { const e = await res.json(); detail = e.message || ''; } catch (e) {}
    throw new Error(detail || ('GitHub write failed (' + res.status + ').'));
  }
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed.' });
  }

  const TOKEN = process.env.GITHUB_TOKEN;
  const PIN   = process.env.ADMIN_PIN;
  if (!TOKEN || !PIN) {
    return json(500, { error: 'Server not configured: GITHUB_TOKEN and ADMIN_PIN must both be set.' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { error: 'Invalid request body.' });
  }

  /* PIN check — performed server-side. */
  if (!body.pin || body.pin !== PIN) {
    return json(401, { error: 'Incorrect PIN.' });
  }

  try {
    if (body.action === 'load') {
      const file = await ghGetFile(TOKEN);
      return json(200, { matches: parseMatches(file.content) });
    }

    if (body.action === 'save') {
      const title  = body.title;
      const status = body.status;
      if (!title || ['upcoming', 'live', 'replay'].indexOf(status) === -1) {
        return json(400, { error: 'A match title and a valid status are required.' });
      }
      const file = await ghGetFile(TOKEN);
      const updated = updateMatchStatus(file.content, title, status);
      if (updated === file.content) {
        return json(409, { error: 'Match not found, or it is already set to that status.' });
      }
      await ghPutFile(TOKEN, updated, file.sha, 'Admin panel: set "' + title + '" -> ' + status);
      return json(200, { ok: true });
    }

    return json(400, { error: 'Unknown action.' });
  } catch (e) {
    return json(502, { error: (e && e.message) || 'Upstream error contacting GitHub.' });
  }
};
