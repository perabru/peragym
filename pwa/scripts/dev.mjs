import http from 'node:http';
import { mkdir } from 'node:fs/promises';
import { LocalD1 } from './d1-local.mjs';
await import('./embed-assets.mjs');
const {default:worker}=await import('../worker/index.js');
await mkdir('.sites-runtime',{recursive:true});
const db=new LocalD1('.sites-runtime/preview.sqlite');db.applyMigrations('drizzle');
const args=process.argv.slice(2),portIndex=args.indexOf('--port');
const port=Number(portIndex>=0?args[portIndex+1]:process.env.PORT||4173);
const server=http.createServer(async(req,res)=>{
  try{
    const chunks=[];for await(const part of req)chunks.push(part);
    const headers=new Headers();for(const [name,value] of Object.entries(req.headers)){if(name.startsWith('oai-authenticated-user-'))continue;if(Array.isArray(value))value.forEach(v=>headers.append(name,v));else if(value!==undefined)headers.set(name,value);}
    const origin=`http://${req.headers.host}`;
    const request=new Request(new URL(req.url,origin),{method:req.method,headers,...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})});
    const response=await worker.fetch(request,{DB:db});
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(500,{'Content-Type':'text/plain'});res.end('Erro no ambiente de prévia.');}
});
server.listen(port,'0.0.0.0',()=>console.log(`PeraGym preview listening on ${port}; authentication is provided only by the hosted platform.`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>{db.close();process.exit(0);}));
