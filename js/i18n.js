// Display-only localisation: game data, identifiers and saved campaigns stay canonical.
import { messages } from './i18n/en.js';

const STORAGE_KEY = 'runes.language.v1';
let language = 'en';
try { if (globalThis.localStorage?.getItem(STORAGE_KEY) === 'fr') language = 'fr'; } catch { /* private browsing */ }
export const getLanguage = () => language;
const normalise = value => String(value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exact = new Map(Object.entries(messages).map(([fr,en]) => [normalise(fr), en]));
const templates = [...exact].filter(([key]) => /\{\w+\}/.test(key) && key.replace(/\{\w+\}/g, '').trim().length >= 4).map(([key,en]) => {
  const names=[];let source='',last=0;
  for (const m of key.matchAll(/\{(\w+)\}/g)) { source+=escape(key.slice(last,m.index))+'(.*)';names.push(m[1]);last=m.index+m[0].length; }
  source+=escape(key.slice(last));
  return { regex:new RegExp('^'+source+'$','u'), names, en, weight:key.replace(/\{\w+\}/g,'').length };
}).sort((a,b)=>b.weight-a.weight);
const fragments = [...exact.keys()].filter(key=>!/[{}]/.test(key)&&key.length>1).sort((a,b)=>b.length-a.length);
const fragmentRegex = new RegExp('(?<![\\p{L}\\p{N}])(?:'+fragments.map(escape).join('|')+')(?![\\p{L}\\p{N}])','gu');
const untranslated = new Set();
function english(source, depth=0) {
  const key=normalise(source);
  if (!key || depth>8) return source;
  if (exact.has(key)) return exact.get(key);
  for (const item of templates) {
    const match=item.regex.exec(key);
    if (!match) continue;
    const values=Object.fromEntries(item.names.map((name,i)=>[name,english(match[i+1],depth+1)]));
    return item.en.replace(/\{(\w+)\}/g,(_,name)=>values[name]??'');
  }
  const result=key.replace(fragmentRegex,value=>exact.get(value));
  if(result===key && /[àâéèêëîïôûùçœ]|\b(?:votre|vos|une|des|sans|pour|avec|dans|sur|sont|aucun)\b/i.test(key)) untranslated.add(key);
  return result;
}
export function translate(source) {
  if(language==='fr'||typeof source!=='string')return source;
  const lead=source.match(/^\s*/)[0],tail=source.match(/\s*$/)[0];
  return lead+english(source)+tail;
}

let installed=false, observer, selector;
const textSources=new WeakMap(), attributeSources=new WeakMap();
const excluded=node=>node.parentElement?.closest('script,style,textarea,pre,code,[data-i18n-ignore]');
function textNode(node) {
  if(excluded(node)||!node.data.trim())return;
  const saved=textSources.get(node);
  const source=saved&&node.data===saved.output?saved.source:node.data;
  const output=translate(source);
  textSources.set(node,{source,output});
  if(node.data!==output)node.data=output;
}
function element(node) {
  if(node.closest('script,style,textarea,pre,code,[data-i18n-ignore]'))return;
  const saved=attributeSources.get(node)||{};
  for(const name of ['title','aria-label','placeholder','alt'])if(node.hasAttribute(name)){
    const current=node.getAttribute(name),old=saved[name];
    const source=old&&old.output===current?old.source:current,output=translate(source);
    saved[name]={source,output};if(output!==current)node.setAttribute(name,output);
  }
  attributeSources.set(node,saved);
}
export function translateTree(root=document.documentElement) {
  if(root.nodeType===3){textNode(root);return;}
  if(root.nodeType!==1)return;
  element(root);
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT);
  while(walker.nextNode())walker.currentNode.nodeType===3?textNode(walker.currentNode):element(walker.currentNode);
}
export function setLanguage(next) {
  if(!['en','fr'].includes(next))return;
  language=next;try{localStorage.setItem(STORAGE_KEY,next);}catch{}
  document.documentElement.lang=language;
  if(selector){selector.value=language;selector.setAttribute('aria-label',language==='en'?'Language':'Langue');}
  // Rebuild text that was laid out before insertion (SVG map labels and rune chips).
  // The existing save/resume path keeps canonical campaign data unchanged.
  location.reload();
}
export function installLocalization() {
  if(installed||typeof document==='undefined')return;installed=true;
  document.documentElement.lang=language;
  document.title='Runes de Commandement';
  const style=document.createElement('style');
  style.textContent='.language-picker{position:fixed;right:12px;top:12px;z-index:9000;color:#f5e5bf;background:#221e16ed;border:1px solid #b99b52;border-radius:6px;font:600 14px/1.3 system-ui;padding:6px 9px;box-shadow:0 2px 8px #0005}.language-picker select{color:inherit;background:transparent;border:0;font:inherit;cursor:pointer}.language-picker option{color:#f5e5bf;background:#221e16}@media(max-width:720px),(max-height:500px){.language-picker{top:74px;right:8px;font-size:12px;padding:4px 6px}}';
  document.head.append(style);
  const box=document.createElement('label');box.className='language-picker';box.dataset.i18nIgnore='';
  const label=document.createElement('span');label.textContent='🌐 ';
  selector=document.createElement('select');selector.id='language-select';
  for(const [value,text]of [['en','English'],['fr','Français']]){const option=document.createElement('option');option.value=value;option.textContent=text;selector.append(option);}
  selector.value=language;selector.setAttribute('aria-label',language==='en'?'Language':'Langue');
  selector.addEventListener('change',()=>setLanguage(selector.value));box.append(label,selector);document.body.append(box);
  observer=new MutationObserver(records=>{
    const roots=new Set();
    for(const record of records){if(record.type==='characterData')textNode(record.target);else if(record.type==='attributes'){if(record.target===document.documentElement){if(document.documentElement.lang!==language)document.documentElement.lang=language;}else element(record.target);}else for(const node of record.addedNodes)roots.add(node);}
    for(const root of roots)translateTree(root);
  });
  observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['title','aria-label','placeholder','alt','lang']});
  // Rendered canvas labels use the same catalogue; numeric geometry and simulation stay untouched.
  if(globalThis.CanvasRenderingContext2D)for(const key of ['fillText','strokeText']){
    const original=CanvasRenderingContext2D.prototype[key];
    CanvasRenderingContext2D.prototype[key]=function(text,...args){return original.call(this,translate(String(text)),...args);};
  }
  translateTree();
  window.__runesI18n={getLanguage,setLanguage,translate,untranslated:()=>[...untranslated],flush:()=>translateTree()};
}
