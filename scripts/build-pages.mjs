import {copyFile,lstat,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const PAGES_FILES=Object.freeze(['index.html','community.css','pages.css','icon-192.png','.nojekyll']);
function serviceEntry(html){
  const anchors=html.match(/<a\b[^>]*>/gi)||[],entries=anchors.filter(tag=>/\bdata-service-entry(?:\s|=|>)/i.test(tag));
  if(!entries.length)throw Error('Public service entry marker missing');
  let selected;
  for(const tag of entries){
    const href=tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    let url;try{url=new URL(href);}catch{throw Error('Public service entry URL invalid');}
    if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/roomly/'||url.search||url.hash)throw Error('Public service entry must be an HTTPS /roomly/ URL');
    if(selected&&url.href!==selected.href)throw Error('Public service entries must use the same URL');
    selected=url;
  }
  for(const tag of anchors){
    const href=tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    let url;try{url=new URL(href);}catch{continue;}
    if(/^\/roomly\/(?:about|privacy|support)\.html$/.test(url.pathname)&&(url.origin!==selected.origin||url.protocol!=='https:'||url.username||url.password||url.search||url.hash))throw Error('Public service help links must use the entry origin');
  }
}
export async function buildPages({projectDir=projectRoot}={}){
  const project=resolve(projectDir),output=join(project,'pages-dist');
  if(basename(output)!=='pages-dist'||dirname(output)!==project)throw Error('Invalid Pages destination');
  try{if((await lstat(output)).isSymbolicLink())throw Error('Pages output must not be a symlink');}catch(error){if(error.code!=='ENOENT')throw error;}
  const html=await readFile(join(project,'community/pages.html'),'utf8');
  if(/<script|(?:demo-fixtures|google\.js|access\.js|api\/)/i.test(html))throw Error('Unexpected integration in Pages landing');
  serviceEntry(html);
  await rm(output,{recursive:true,force:true});await mkdir(output,{recursive:true});
  for(const file of ['community.css','pages.css'])await copyFile(join(project,'community',file),join(output,file));
  await copyFile(join(project,'icon-192.png'),join(output,'icon-192.png'));await writeFile(join(output,'index.html'),html);await writeFile(join(output,'.nojekyll'),'');return output;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){await buildPages();console.log('Built GitHub Pages entry for the public Roomly service');}
