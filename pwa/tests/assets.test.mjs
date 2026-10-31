import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';

// Exercise the actual asset embedder and HTTP handler: a UTF-8 conversion of a
// JPEG or TrueType font can build successfully while corrupting the website.
execFileSync(process.execPath,['scripts/embed-assets.mjs'],{cwd:new URL('..',import.meta.url),stdio:'pipe'});
const {default:worker}=await import('../worker/index.js');
test('embedded retro artwork and local fonts retain exact bytes and browser MIME types',async()=>{
  for(const [path,mime] of [['/assets/night-drive.jpg','image/jpeg'],['/assets/cassette.svg','image/svg+xml'],['/assets/fonts/bungee.ttf','font/ttf'],['/assets/fonts/yellowtail.ttf','font/ttf']]){
    const response=await worker.fetch(new Request('https://peragym.test'+path));
    assert.equal(response.status,200,path);assert.equal(response.headers.get('Content-Type'),mime,path);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),await readFile(new URL('../web'+path,import.meta.url)),path);
  }
});
test('public artwork routing cannot expose source files or private directories',async()=>{
  for(const path of ['/assets/unknown.ttf','/assets/server/worker.js','/assets/fonts/../../server/worker.js','/.env.example','/server/worker.js']){
    const response=await worker.fetch(new Request('https://peragym.test'+path));assert.equal(response.status,404,path);
  }
});
