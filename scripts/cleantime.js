#!/usr/bin/env node
const {google} = require('googleapis');
require('dotenv').config();

async function main() {
  const args = process.argv.slice(2);
  const opts = { root: 'root', dryRun: false, minCount: 2, groupOnly: false, verbose: false };
  args.forEach(a => {
    if (a.startsWith('--root=')) opts.root = a.split('=')[1];
    if (a === '--dry-run') opts.dryRun = true;
    if (a.startsWith('--min-count=')) opts.minCount = Number(a.split('=')[1]) || 2;
    if (a === '--group-only') opts.groupOnly = true;
    if (a === '--verbose' || a === '-v') opts.verbose = true;
  });

  // Build an auth client. Prefer tokens from env (.env) if present; else use ADC (GoogleAuth).
  let authClient;
  const {
    CLIENT_ID,
    CLIENT_SECRET,
    GOOGLE_ACCESS_TOKEN,
    GOOGLE_REFRESH_TOKEN,
    GOOGLE_TOKEN_TYPE,
    GOOGLE_EXPIRY_DATE,
  } = process.env;

  if ((GOOGLE_ACCESS_TOKEN || GOOGLE_REFRESH_TOKEN) && CLIENT_ID && CLIENT_SECRET) {
    const oAuth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
    const creds = {};
    if (GOOGLE_ACCESS_TOKEN) creds.access_token = GOOGLE_ACCESS_TOKEN;
    if (GOOGLE_REFRESH_TOKEN) creds.refresh_token = GOOGLE_REFRESH_TOKEN;
    if (GOOGLE_TOKEN_TYPE) creds.token_type = GOOGLE_TOKEN_TYPE;
    if (GOOGLE_EXPIRY_DATE) creds.expiry_date = Number(GOOGLE_EXPIRY_DATE);
    oAuth2.setCredentials(creds);
    authClient = oAuth2;
    console.log('Using OAuth2 client from environment tokens.');
  } else {
    const gAuth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    try {
      authClient = await gAuth.getClient();
      console.log('Using Application Default Credentials (GoogleAuth).');
    } catch (err) {
      console.error('Failed to obtain Application Default Credentials:', err.message || err);
      process.exit(1);
    }
  }

  const drive = google.drive({ version: 'v3', auth: authClient });

  // Batch-list all files (folders + non-folders) once, build parent map and count direct children
  console.log(`Listing all files (this may take a moment)...`);
  const allFiles = [];
  let pageToken;
  const qAll = `trashed = false`;
  let page = 0;
  let filesListed = 0;
  try {
    do {
      page++;
      const res = await drive.files.list({
        q: qAll,
        fields: 'nextPageToken, files(id, name, mimeType, parents)',
        pageSize: 1000,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      const got = res.data.files ? res.data.files.length : 0;
      filesListed += got;
      if (res.data.files) allFiles.push(...res.data.files);
      pageToken = res.data.nextPageToken;
      if (opts.verbose) console.log(`  page ${page}: got ${got} files (total ${filesListed})${pageToken ? ', more...' : ''}`);
    } while (pageToken);
    if (opts.verbose) console.log(`Finished listing: ${filesListed} files across ${page} page(s).`);
  } catch (err) {
    console.error('Failed listing files:', err.message || err);
    process.exit(1);
  }

  // Build maps
  const fileById = new Map();
  const childrenMap = new Map(); // parentId -> [childId,...]
  for (const f of allFiles) {
    fileById.set(f.id, f);
    if (f.parents && Array.isArray(f.parents)) {
      for (const p of f.parents) {
        const arr = childrenMap.get(p) || [];
        arr.push(f.id);
        childrenMap.set(p, arr);
      }
    }
  }
  if (opts.verbose) {
    const totalFiles = allFiles.length;
    const totalFolders = allFiles.filter(x => x.mimeType === 'application/vnd.google-apps.folder').length;
    console.log(`Built maps: ${totalFiles} files, ${totalFolders} folders, ${childrenMap.size} parents with children.`);
  }

  // Determine subtree of root (if root !== 'root')
  const subtree = new Set();
  if (opts.root === 'root') {
    // include all folders
    for (const [id, f] of fileById.entries()) {
      if (f.mimeType === 'application/vnd.google-apps.folder') subtree.add(id);
    }
  } else {
    // BFS from opts.root
    const queue = [opts.root];
    while (queue.length) {
      const cur = queue.shift();
      if (!subtree.has(cur)) subtree.add(cur);
      const children = childrenMap.get(cur) || [];
      for (const c of children) {
        const f = fileById.get(c);
        if (f && f.mimeType === 'application/vnd.google-apps.folder') queue.push(c);
      }
    }
  }

  // Find empty folders: direct child count === 0
  const emptyFolders = [];
  for (const id of subtree) {
    if (id === opts.root) continue;
    const f = fileById.get(id);
    if (!f) continue;
    if (f.mimeType !== 'application/vnd.google-apps.folder') continue;
    const childIds = childrenMap.get(id) || [];
    const directCount = childIds.length;
    if (directCount === 0) {
      // build path (best-effort, limited depth to avoid cycles)
      let path = f.name || id;
      // attempt to build path by walking parents up to root (stop on missing parent or depth>10)
      let curParents = f.parents || [];
      let depth = 0;
      let curId = id;
      while (curParents && curParents.length && depth < 10) {
        const p = curParents[0];
        if (p === opts.root) break;
        const pf = fileById.get(p);
        if (!pf) break;
        path = `${pf.name}/${path}`;
        curParents = pf.parents;
        depth++;
      }
      emptyFolders.push({ id, name: f.name, path, depth });
    }
  }

  if (emptyFolders.length === 0) {
    console.log('No empty folders (direct children === 0) found under the specified root.');
    return;
  }

  if (opts.verbose) {
    console.log(`Empty folders sample (up to 20):`);
    for (const e of emptyFolders.slice(0, 20)) console.log(`  - ${e.path} (${e.id})`);
    if (emptyFolders.length > 20) console.log(`  ... and ${emptyFolders.length - 20} more`);
  }

  // Sort by depth desc then path
  emptyFolders.sort((a, b) => {
    if (b.depth !== a.depth) return b.depth - a.depth;
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    return 0;
  });

  console.log(`Found ${emptyFolders.length} empty folders (direct children === 0).`);

  let deletedCount = 0;
  for (const f of emptyFolders) {
    if (opts.dryRun) {
      console.log(`[dry-run] Would delete: ${f.path} (${f.id})`);
    } else {
      try {
        await drive.files.delete({ fileId: f.id, supportsAllDrives: true });
        deletedCount++;
        console.log(`Deleted: ${f.path} (${f.id})`);
      } catch (err) {
        console.error(`Failed to delete ${f.path} (${f.id}):`, err.message || err);
      }
    }
  }

  console.log(`Done. Deleted ${deletedCount} folders${opts.dryRun ? ' (dry-run)' : ''}.`);
}

main().catch(err => { console.error(err); process.exit(1); });
