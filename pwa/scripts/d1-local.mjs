import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync } from 'node:fs';
import path from 'node:path';
export class LocalD1 {
  constructor(file=':memory:'){
    this.sqlite=new DatabaseSync(file);this.sqlite.exec('PRAGMA foreign_keys=ON');
  }
  applyMigrations(directory){
    this.sqlite.exec('CREATE TABLE IF NOT EXISTS __local_migrations(name TEXT PRIMARY KEY)');
    for(const name of readdirSync(directory).filter(n=>n.endsWith('.sql')).sort()){
      if(this.sqlite.prepare('SELECT name FROM __local_migrations WHERE name=?').get(name))continue;
      this.sqlite.exec('BEGIN');
      try{this.sqlite.exec(readFileSync(path.join(directory,name),'utf8'));this.sqlite.prepare('INSERT INTO __local_migrations(name) VALUES(?)').run(name);this.sqlite.exec('COMMIT');}catch(e){this.sqlite.exec('ROLLBACK');throw e;}
    }
  }
  prepare(sql){
    const db=this.sqlite;
    function statement(args=[]){return {bind(...next){return statement(next);},async first(column){const row=db.prepare(sql).get(...args);return column?row?.[column]??null:row??null;},async all(){return {success:true,results:db.prepare(sql).all(...args),meta:{}};},async run(){const result=db.prepare(sql).run(...args);return {success:true,meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)}};}};}
    return statement();
  }
  close(){this.sqlite.close();}
}
