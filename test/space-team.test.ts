import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function harness() {
  let writes = 0;
  const listeners = new Map<string, (e:any)=>void>();
  const doc: any = { activeElement: null, addEventListener(name:string, callback:(e:any)=>void) {listeners.set(name,callback);}, removeEventListener() {}, createDocumentFragment: () => new Element("fragment") };
  class Element {
    children: Element[] = []; parent: Element | null = null; attributes = new Map<string,string>(); dataset: Record<string,string> = {};
    value = ""; open = false; hidden = false; ownText = ""; ownerDocument = doc; onclick?: (e: unknown) => void; scrollTop = 0; scrollLeft = 0;
    constructor(public tag: string) {}
    set textContent(v: string) { this.ownText = v; this.children = []; writes++; }
    get textContent(): string { return this.ownText + this.children.map(c=>c.textContent).join(""); }
    contains(node: Element | null): boolean { return node === this || this.children.some((c) => c.contains(node)); }
    get isConnected(): boolean { return this.tag === "root" || Boolean(this.parent?.isConnected); }
    setAttribute(k: string,v: string) { this.attributes.set(k,String(v)); if(k.startsWith("data-")) this.dataset[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=String(v); writes++; }
    getAttribute(k: string) { return this.attributes.get(k) ?? null; }
    append(...children: Element[]) { for(const child of children.flat()) { if(child.tag === "fragment") this.append(...child.children); else { child.parent=this; this.children.push(child); writes++; } } }
    replaceChildren(...children: Element[]) { for(const c of this.children)c.parent=null; this.children=[]; this.ownText=""; this.append(...children); writes++; }
    querySelectorAll(selector: string): Element[] {
      const matches = (node: Element,s: string) => {
        const tag = s.match(/^[a-z]+/)?.[0]; if(tag && node.tag!==tag)return false;
        const cls = s.match(/\.([\w-]+)/)?.[1]; if(cls && !(node.getAttribute("class")??"").split(" ").includes(cls))return false;
        for(const a of s.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g))if(a[2]===undefined ? node.getAttribute(a[1]!)===null : node.getAttribute(a[1]!)!==a[2])return false;
        return true;
      };
      return this.children.flatMap(c=>[...(selector.split(",").some(s=>matches(c,s))?[c]:[]),...c.querySelectorAll(selector)]);
    }
    querySelector(s:string) { return this.querySelectorAll(s)[0] ?? null; }
    focus() { doc.activeElement=this; }
    closest() { return main; }
    remove() { if(this.parent)this.parent.children=this.parent.children.filter(c=>c!==this); this.parent=null; }
  }
  const main = new Element("main"), root = new Element("root");
  const h = (tag:string,props:Record<string,any>={},...children:any[]): Element => { const n=new Element(tag); for(const[k,v]of Object.entries(props)){if(k==="text")n.textContent=v;else if(k==="hidden")n.hidden=v;else if(k.startsWith("on"))(n as any)[k]=v;else n.setAttribute(k==="class"?"class":k,String(v));} n.append(...children.flat().filter(Boolean).map(c=>typeof c==="string"?h("text",{text:c}):c));return n; };
  const teamSource=readFileSync(new URL("../shell/space-team.js",import.meta.url),"utf8");
  const source=readFileSync(new URL("../shell/space.js",import.meta.url),"utf8");
  const storage=new Map(); const nav: any[]=[]; let back=0;
  const api=runInNewContext(`${teamSource.replace(/^export /gm,"")}\n${source.replace(/^import .*;$/gm,"").replace(/^export /gm,"")}\n({createSpaceRenderer,mergeSpaceScenes})`,{document:doc,window:{scrollX:0,scrollY:0,scrollTo(){}},history:{back(){back++;}},localStorage:{getItem:(k:string)=>storage.get(k),setItem:(k:string,v:string)=>storage.set(k,v)},ResizeObserver:class{observe(){}disconnect(){}},CSS:{escape:(v:string)=>v},createSpaceViewController(){throw new Error("Hidden Room initialized");},Date});
  const renderer=api.createSpaceRenderer(root,{h,pets:()=>[],packs:()=>[],navigateSpace:(params:any)=>nav.push(params),navigate:(...args:any[])=>nav.push(args)});
  const scene={groups:[{id:"alpha",title:"Alpha"}],actors:[{id:"one",name:"Exact / name",state:"working",roles:["implementer"],since:"2026-01-01T00:00:00Z",group:"alpha",card:"task",marks:[{kind:"inbox",text:"3 inbox"},{kind:"approval",text:"1 approval"}],link:{panel:"notes"}},{id:"two",name:"Resting",state:"idle",group:"alpha",marks:[],link:{panel:"notes"}}],zones:[{id:"work",title:"Work",count:1,group:"alpha"}],cards:[{id:"task",title:"Task title",zone:"work",group:"alpha",link:{panel:"notes",params:{id:"task"}}}],links:[{kind:"cohort",from:"one",to:"two"}]};
  const model=api.mergeSpaceScenes(new Map([["demo",{scene,sampledAt:1}]]));
  return {api,renderer,root,model,doc,nav,listeners,get writes(){return writes;},get back(){return back;}};
}
test("Team is default, shows attention/roles/task/badges and collapsed resting actors without Room initialization",()=>{
  const h=harness();h.renderer.setRoute({});h.renderer.update(h.model);
  expect(h.root.dataset.spaceSection).toBe("team");
  expect(h.root.textContent).toContain("Needs attention");expect(h.root.textContent).toContain("Exact / name");expect(h.root.textContent).toContain("implementer");expect(h.root.textContent).toContain("Task title");expect(h.root.textContent).toContain("3 inbox");
  expect(h.root.querySelector("details[data-group-id]")?.open).toBe(false);
  const before=h.writes;h.renderer.update({...h.model,sampledAt:2});expect(h.writes).toBe(before);
});
test("actor detail resolves exact actor/card/partners and closes with focus restoration",()=>{
  const h=harness();h.renderer.setRoute({});h.renderer.update(h.model);
  const actor=h.root.querySelector('[data-space-actor="demo:one"]')!;actor.focus();actor.onclick?.({currentTarget:actor});expect(h.nav.at(-1).actor).toBe("demo:one");
  h.renderer.setRoute({actor:"demo:one"});h.renderer.update(h.model);
  const detail=h.root.querySelector(".space-agent-detail")!;expect(detail.hidden).toBe(false);expect(detail.textContent).toContain("Alpha");expect(detail.textContent).toContain("cohort: Resting");expect(detail.textContent).toContain("Open in demo");expect(detail.textContent).toContain("History appears once observed.");
  const before=h.writes;h.renderer.update({...h.model,sampledAt:3});expect(h.writes).toBe(before);
  detail.querySelectorAll("button").find((n:any)=>n.textContent==="Task title")!.onclick?.({});
  expect(h.nav.at(-1)).toEqual(["demo","notes",{id:"task"}]);
  h.root.querySelector(".space-detail-back")!.onclick?.({});expect(h.back).toBe(1);
  h.renderer.setRoute({});h.renderer.update(h.model);expect(detail.hidden).toBe(true);expect(h.doc.activeElement).toBe(actor);
});
test("unknown actor and group notices wait for scene reports",()=>{
  const h=harness();h.renderer.setRoute({actor:"unknown",group:"unknown"});
  h.renderer.update({...h.model,pending:1});expect(h.root.textContent).not.toContain("Project not in the current scene");expect(h.root.textContent).toContain("Waiting for agent data.");
  h.renderer.update({...h.model,pending:0});expect(h.root.textContent).toContain("Project not in the current scene");expect(h.root.textContent).toContain("Agent not in the current scene");
  h.renderer.setRoute({});h.renderer.update(h.model);expect(h.doc.activeElement.getAttribute("data-space-section-tab")).toBe("team");
});

test("group limits are per source and never erase another source's group identity",()=>{
  const h=harness();const groups=Array.from({length:150},(_,i)=>({id:`g${i}`,title:`Group ${i}`}));
  const scene={groups,actors:[{id:"actor",name:"Actor",group:"g149",state:"idle",link:{panel:"notes"}}],zones:[],cards:[],links:[]};
  const merged=h.api.mergeSpaceScenes(new Map([["a",{scene}],["b",{scene}]]));
  expect(merged.groups).toHaveLength(300);expect(merged.actors.map((a:any)=>a.group)).toEqual(["a:g149","b:g149"]);
});
test("internal Space routes keep poll deadlines and do not start a re-poll",async()=>{
  const source=readFileSync(new URL("../shell/shell.js",import.meta.url),"utf8");
  const body=source.slice(source.indexOf("async function showSpace("),source.indexOf("function renderSpace("));
  const entry={next:1234};const state={route:{area:"space",params:{view:"team"}},space:new Map([["demo",entry]])};
  const forced:boolean[]=[];let polls=0;
  const show=runInNewContext(`${body}\nshowSpace`,{spaceLoading:Promise.resolve(),spaceRenderer:{setRoute(){}},state,spaceTools:()=>[{tool:"demo"}],renderSpace:(v:boolean)=>forced.push(v),pollSpace:()=>{polls++;}}) as (internal:boolean)=>Promise<void>;
  await show(true);expect(entry.next).toBe(1234);expect(polls).toBe(0);expect(forced).toEqual([false]);
  await show(false);expect(entry.next).toBe(0);expect(polls).toBe(1);
});

test("changed actor facts retain the exact detail control and missing controls fall back to Back",()=>{
  const h=harness();h.renderer.setRoute({actor:"demo:one"});h.renderer.update(h.model);
  const detail=h.root.querySelector(".space-agent-detail")!;
  detail.querySelector('[data-detail-focus="open"]')!.focus();
  const changed={...h.model,actors:h.model.actors.map((a:any)=>({...a,name:a.name+" changed"}))};
  h.renderer.update(changed);
  expect(detail.contains(h.doc.activeElement)).toBe(true);
  expect(h.doc.activeElement.getAttribute("data-detail-focus")).toBe("open");
  detail.querySelector('[data-detail-focus="task"]')!.focus();
  h.renderer.update({...changed,actors:changed.actors.map((a:any)=>({...a,card:undefined}))});
  expect(h.doc.activeElement.getAttribute("data-detail-focus")).toBe("back");
  h.root.focus();let prevented=false;
  h.listeners.get("keydown")!({key:"Tab",preventDefault(){prevented=true;}});
  expect(prevented).toBe(true);expect(h.doc.activeElement.getAttribute("data-detail-focus")).toBe("back");
});
test("changed Team facts preserve shortcut, disclosure, attention and tile focus independently",()=>{
  const h=harness();h.renderer.setRoute({});h.renderer.update(h.model);
  let turn=0;
  for(const key of ["shortcut:demo:alpha:board","shortcut:demo:alpha:flow","resting:demo:alpha","attention:demo:one","tile:demo:one"]) {
    h.root.querySelector(`[data-team-focus="${key}"]`)!.focus();
    turn++;h.renderer.update({...h.model,actors:h.model.actors.map((a:any)=>({...a,name:a.name+turn}))});
    expect(h.doc.activeElement.getAttribute("data-team-focus")).toBe(key);
    expect(h.doc.activeElement.isConnected).toBe(true);
  }
});
test("resting summary groups idle and away names once per state",()=>{
  const h=harness();h.renderer.setRoute({});
  const resting=h.model.actors[1];
  h.renderer.update({...h.model,actors:[...h.model.actors,{...resting,id:"other",name:"Other"},{...resting,id:"away",name:"Away",state:"away"}]});
  expect(h.root.querySelector('[data-team-focus="resting:demo:alpha"]')!.textContent).toBe("idle: Resting, Other · away: Away");
});
