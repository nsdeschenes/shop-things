import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';

const root = new URL('../packages/electron/dist/renderer/', import.meta.url);
createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1:5179');
  const file = new URL(url.pathname === '/' ? 'index.html' : `.${url.pathname}`, root);
  if (!file.href.startsWith(root.href)) {
    response.writeHead(403).end();
    return;
  }

  try {
    const body = await readFile(fileURLToPath(file));
    const type = file.pathname.endsWith('.js')
      ? 'text/javascript'
      : file.pathname.endsWith('.css')
        ? 'text/css'
        : 'text/html';
    response.writeHead(200, {'Content-Type': type}).end(body);
  } catch {
    response.writeHead(404).end();
  }
}).listen(5179, '127.0.0.1');
