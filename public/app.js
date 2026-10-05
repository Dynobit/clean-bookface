// Progressive enhancements only. Account, feed and sharing forms work without JavaScript.
for (const form of document.querySelectorAll('form[data-confirm]')) {
  form.addEventListener('submit', (event) => {
    if (!window.confirm(form.dataset.confirm)) event.preventDefault();
  });
}
async function uploadRequest(url, init = {}, retries = 0, timeoutMs = 60000) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      let data;
      try {
        data = await response.json();
      } catch {
        data = {};
      }
      if (!response.ok) {
        const error = new Error(data.error || 'The upload could not continue. Please try again.');
        error.status = response.status;
        throw error;
      }
      return data;
    } catch (error) {
      if (attempt >= retries || (error.status && error.status < 500 && error.status !== 429))
        throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, error.status === 429 ? 30000 : 1000 * 2 ** attempt),
      );
    }
  }
}
const chunkHash = async (blob) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
for (const form of document.querySelectorAll('form[data-upload]')) {
  const input = form.querySelector('input[type=file]');
  const button = form.querySelector('button[type=submit]');
  const status = form.querySelector('[role=status]');
  const cancel = form.querySelector('[data-cancel-upload]');
  const archiveUpload = new URL(form.action).pathname === '/api/imports';
  const key = `bookface-upload:${input.id}`;
  let uploadId;
  try {
    uploadId = sessionStorage.getItem(key);
  } catch {}
  const remember = (id) => {
    uploadId = id;
    try {
      if (id) sessionStorage.setItem(key, id);
      else sessionStorage.removeItem(key);
    } catch {}
    if (cancel) {
      cancel.hidden = !id;
      cancel.style.display = id ? '' : 'none';
    }
  };
  const headers = () => ({ Accept: 'application/json', 'X-CSRF-Token': form.elements.csrf.value });
  if (cancel) {
    cancel.hidden = !uploadId;
    cancel.style.display = uploadId ? '' : 'none';
    cancel.addEventListener('click', async () => {
      if (!uploadId) return;
      cancel.disabled = true;
      try {
        await uploadRequest(`/api/uploads/${encodeURIComponent(uploadId)}/cancel`, {
          method: 'POST',
          headers: headers(),
        });
        remember(null);
        status.textContent = 'Unfinished upload removed. You can choose new files.';
      } catch (error) {
        if (error.status === 404) {
          remember(null);
          status.textContent = 'That unfinished upload has expired. You can start again.';
        } else status.textContent = error.message;
      } finally {
        cancel.disabled = false;
      }
    });
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!input.files.length) {
      status.textContent = 'Choose files to upload.';
      return;
    }
    button.disabled = true;
    if (cancel) cancel.disabled = true;
    status.textContent = 'Preparing your private upload…';
    try {
      if (!archiveUpload) {
        const body = new FormData();
        for (const field of form.querySelectorAll('input[type=hidden]'))
          body.append(field.name, field.value);
        for (const file of input.files)
          body.append('files', file, file.webkitRelativePath || file.name);
        // Photo batches use multipart, so allow slow connections the server's full request window.
        const data = await uploadRequest(
          form.action,
          { method: 'POST', body, headers: headers() },
          0,
          30 * 60_000,
        );
        location.assign(data.redirect || '/imports');
        return;
      }
      const files = Array.from(input.files).sort((a, b) =>
        (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name),
      );
      const manifest = files.map((file) => ({
        name: file.webkitRelativePath || file.name,
        size: file.size,
      }));
      let state;
      if (uploadId) {
        try {
          state = await uploadRequest(`/api/uploads/${encodeURIComponent(uploadId)}`, {
            headers: headers(),
          });
        } catch (error) {
          if (error.status === 404) remember(null);
          else throw error;
        }
      }
      if (!state) {
        const pending = await uploadRequest('/api/uploads', { headers: headers() });
        state = pending.upload;
        if (state) remember(state.id);
      }
      if (state?.state === 'committed') {
        remember(null);
        location.assign('/imports');
        return;
      }
      if (state) {
        if (
          state.files.length !== manifest.length ||
          state.files.some(
            (file, i) => file.name !== manifest[i].name || file.size !== manifest[i].size,
          )
        )
          throw new Error(
            'Choose the same files to resume, or cancel the unfinished upload to start again.',
          );
        status.textContent = 'Checking your files against the parts already received…';
        for (const part of state.chunks) {
          if (
            (await chunkHash(files[part.fileIndex].slice(part.offset, part.offset + part.size))) !==
            part.sha256
          )
            throw new Error(
              'These files differ from the unfinished upload. Select the original files, or cancel and start again.',
            );
        }
      } else {
        state = await uploadRequest('/api/uploads', {
          method: 'POST',
          headers: { ...headers(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ manifest: JSON.stringify(manifest) }),
        });
        remember(state.id);
      }
      const total = files.reduce((sum, file) => sum + file.size, 0);
      let received = state.files.reduce((sum, file) => sum + file.offset, 0);
      for (let index = 0; index < files.length; index++) {
        for (
          let offset = state.files[index].offset;
          offset < files[index].size;
          offset += state.chunkBytes
        ) {
          const part = files[index].slice(offset, offset + state.chunkBytes);
          status.textContent = `Uploading privately: ${Math.floor((received / Math.max(1, total)) * 100)}%. Keep this page open. If interrupted, return and select the same files.`;
          const sha256 = await chunkHash(part);
          await uploadRequest(
            `/api/uploads/${encodeURIComponent(uploadId)}/files/${index}?offset=${offset}`,
            {
              method: 'PUT',
              headers: {
                ...headers(),
                'Content-Type': 'application/octet-stream',
                'X-Chunk-SHA256': sha256,
              },
              body: part,
            },
            2,
          );
          received += part.size;
        }
      }
      status.textContent = 'Upload complete. Starting your private import…';
      const data = await uploadRequest(
        `/api/uploads/${encodeURIComponent(uploadId)}/commit`,
        { method: 'POST', headers: headers() },
        2,
      );
      remember(null);
      location.assign(data.redirect || '/imports');
    } catch (error) {
      status.textContent =
        error.message +
        (archiveUpload && uploadId
          ? ' Your received parts are saved for up to 24 hours. Choose the same files and try again, or cancel below.'
          : '');
    } finally {
      button.disabled = false;
      if (cancel) cancel.disabled = false;
    }
  });
}
for (const button of document.querySelectorAll('[data-copy-target]')) {
  button.addEventListener('click', async () => {
    const input = document.getElementById(button.dataset.copyTarget);
    try {
      await navigator.clipboard.writeText(input.value);
      button.textContent = 'Copied';
    } catch {
      input.select();
      button.textContent = 'Select and copy';
    }
  });
}
const recoveryCodes = document.getElementById('recovery-codes');
if (recoveryCodes) {
  const codes = recoveryCodes;
  const status = document.querySelector('[data-recovery-copy-status]');
  const recoveryCopy = document.createElement('button');
  recoveryCopy.type = 'button';
  recoveryCopy.className = 'secondary';
  recoveryCopy.dataset.copyRecovery = '';
  recoveryCopy.textContent = 'Copy all recovery codes';
  status.before(recoveryCopy);
  recoveryCopy.addEventListener('click', async () => {
    status.textContent = '';
    try {
      await navigator.clipboard.writeText(
        Array.from(codes.querySelectorAll('code'), (code) => code.textContent).join('\n'),
      );
      status.textContent =
        'Recovery codes copied. Paste them somewhere private before leaving this page.';
    } catch {
      status.textContent =
        'Could not copy automatically. Select the codes above and copy them, or write them down.';
    }
  });
}
const importState = document.querySelector('[data-running-import]');
if (importState) {
  let checks = 0;
  const check = async () => {
    if (document.hidden) {
      setTimeout(check, 5000);
      return;
    }
    try {
      const r = await fetch('/api/imports', { headers: { Accept: 'application/json' } });
      if (r.ok) {
        const data = await r.json();
        if (!data.jobs.some((j) => ['queued', 'running'].includes(j.status))) {
          location.reload();
          return;
        }
        importState.textContent =
          'Import is running safely in the background. You can leave this page.';
      }
    } catch {}
    if (++checks < 720) setTimeout(check, 5000);
  };
  setTimeout(check, 3000);
}
