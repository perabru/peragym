import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=path.resolve(fileURLToPath(new URL('../../',import.meta.url)));
const publicRoot=path.join(repo,'docs');
const args=process.argv.slice(2),index=args.indexOf('--port');
const port=Number(index>=0?args[index+1]:process.env.PORT||4173);
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.ttf':'font/ttf','.txt':'text/plain; charset=utf-8'};
const prefix='/peragym/docs/';
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);return res.end();}
  if(url.pathname==='/'||url.pathname==='/peragym'){res.writeHead(303,{Location:'/peragym/'});return res.end();}
  let file;
  if(url.pathname==='/peragym/')file=path.join(repo,'index.html');
  else if(url.pathname.startsWith(prefix)){
   file=path.resolve(publicRoot,decodeURIComponent(url.pathname.slice(prefix.length))||'index.html');
   if(!file.startsWith(publicRoot+path.sep)){res.writeHead(404);return res.end();}
   const info=await stat(file);
   if(info.isDirectory()){
    if(!url.pathname.endsWith('/')){res.writeHead(303,{Location:url.pathname+'/'+url.search});return res.end();}
    file=path.join(file,'index.html');
   }
  }else{res.writeHead(404);return res.end('Não encontrado');}
  const bytes=await readFile(file);
  res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store','Referrer-Policy':'strict-origin-when-cross-origin'});
  res.end(req.method==='HEAD'?undefined:bytes);
 }catch{res.writeHead(404);res.end('Não encontrado');}
});
server.listen(port,'0.0.0.0',()=>console.log(`GitHub Pages preview on ${port}`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));
