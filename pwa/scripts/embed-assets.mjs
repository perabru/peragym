import { build } from 'esbuild';
import { readdir,readFile,mkdir } from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(),web=path.join(root,'web');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.ttf':'font/ttf','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8'};
const binaryTypes=new Set(['.png','.jpg','.jpeg','.webp','.ttf','.woff2']);
const assets={};
async function scan(dir){for(const item of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const file=path.join(dir,item.name);if(item.isDirectory())await scan(file);else if(!/\.test\.|\.map$/.test(item.name)){const ext=path.extname(file);if(!types[ext])throw new Error(`Unsupported deployable file: ${file}`);const bytes=await readFile(file);const binary=binaryTypes.has(ext);assets['/'+path.relative(web,file).split(path.sep).join('/')]={type:types[ext],encoding:binary?'base64':'utf8',body:binary?bytes.toString('base64'):bytes.toString('utf8')};}}}
await scan(web);await mkdir(path.join(root,'worker'),{recursive:true});
await build({entryPoints:['server/worker.js'],outfile:'worker/index.js',bundle:true,format:'esm',platform:'browser',target:'es2022',define:{__PERAGYM_ASSETS__:JSON.stringify(assets)},legalComments:'inline'});
console.log(`Embedded ${Object.keys(assets).length} resources; PeraGym is public and free, with optional Pix support.`);
