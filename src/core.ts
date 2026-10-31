import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const Request = z.object({
  name:z.string().regex(/^[a-z][a-z0-9-]{2,30}$/),
  module:z.literal('local-network-v1'),
  cidr:z.string(), subnets:z.array(z.string()).min(1).max(8),
  ingress:z.array(z.object({cidr:z.string(),port:z.number().int().min(1).max(65535)}).strict()).max(20),
  iam:z.array(z.string().regex(/^[a-z0-9]+:[A-Za-z]+$/)).max(20),
  encrypted:z.boolean(), tags:z.object({owner:z.string().min(1).max(80),environment:z.enum(['development','staging'])}).strict()
}).strict();
export type Spec=z.infer<typeof Request>;
export type Actor={id:string;tenant:string;role:'requester'|'approver'|'operator'|'viewer'};
export type Plan={digest:string;policy:string;findings:string[];created:number;resources:Spec};
export type Entry={id:string;tenant:string;author:string;spec:Spec;state:'submitted'|'denied'|'planned'|'approved'|'applied'|'destroyed';plan?:Plan;approval?:{actor:string;digest:string};inventory?:Spec;revision:number};
export function digest(v:unknown){return createHash('sha256').update(JSON.stringify(v)).digest('hex');}
export function network(s:string):[number,number]{
 const m=/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(s);if(!m)throw Error('IPv4 CIDR required');
 const a=m.slice(1).map(Number),p=a[4];if(a.slice(0,4).some(v=>v>255)||p>32)throw Error('Invalid CIDR');
 const n=a.slice(0,4).reduce((n,v)=>n*256+v,0),size=2**(32-p);if(n%size)throw Error('CIDR must use network address');return[n,n+size-1];
}
export function overlaps(a:string,b:string){const [x,y]=network(a),[u,v]=network(b);return x<=v&&u<=y;}
export function validate(spec:Spec){const [lo,hi]=network(spec.cidr);for(const [i,s] of spec.subnets.entries()){const [a,b]=network(s);if(a<lo||b>hi)throw Error('Subnet outside VPC');for(const t of spec.subnets.slice(0,i))if(overlaps(s,t))throw Error('Overlapping subnets');}for(const r of spec.ingress)network(r.cidr);}
export const policyPath=resolve('policies/request.rego');
import { readFileSync } from 'node:fs';
export function policyHash(){return digest(readFileSync(policyPath,'utf8'));}
export function evaluate(spec:Spec):string[]{
 const dir=mkdtempSync(join(tmpdir(),'infraforge-'));
 try{writeFileSync(join(dir,'input.json'),JSON.stringify(spec),{mode:0o600});const bytes=readFileSync(policyPath);writeFileSync(join(dir,'policy.rego'),bytes,{mode:0o600});const out=execFileSync(resolve('.tools/opa'),['eval','--format=json','--data',join(dir,'policy.rego'),'--input',join(dir,'input.json'),'data.infraforge.deny'],{timeout:10000,maxBuffer:1024*1024});const value=JSON.parse(out.toString()).result?.[0]?.expressions?.[0]?.value;if(!Array.isArray(value)||value.some(x=>typeof x!=='string'))throw Error('Undefined policy result');return value;}finally{rmSync(dir,{recursive:true,force:true});}
}
export class Forge{
 entries=new Map<string,Entry>();audit:{at:string;actor:string;tenant:string;action:string;id:string;hash:string}[]=[];
 constructor(private now=()=>Date.now()){}
 event(a:Actor,action:string,id:string){const e={at:new Date(this.now()).toISOString(),actor:a.id,tenant:a.tenant,action,id};this.audit.push({...e,hash:digest([this.audit.at(-1)?.hash,e])});}
 permit(a:Actor,roles:Actor['role'][]){if(!a.id||!a.tenant||!roles.includes(a.role))throw Error('Forbidden');}
 get(a:Actor,id:string){this.permit(a,['requester','approver','operator','viewer']);const e=this.entries.get(id);if(!e||e.tenant!==a.tenant)throw Error('Not found');return structuredClone(e);}
 list(a:Actor){this.permit(a,['requester','approver','operator','viewer']);return [...this.entries.values()].filter(e=>e.tenant===a.tenant).map(e=>structuredClone(e));}
 submit(a:Actor,input:unknown){this.permit(a,['requester']);const spec=Request.parse(input);validate(spec);for(const e of this.entries.values())if(e.tenant===a.tenant&&e.state!=='destroyed'&&overlaps(spec.cidr,e.spec.cidr))throw Error('Network reservation overlaps');const e:Entry={id:randomUUID(),tenant:a.tenant,author:a.id,spec,state:'submitted',revision:1};this.entries.set(e.id,e);this.event(a,'submit',e.id);return structuredClone(e);}
 plan(a:Actor,id:string){this.permit(a,['requester','operator']);const e=this.get(a,id);if(!['submitted','denied','planned','approved'].includes(e.state))throw Error('Invalid transition');const policy=policyHash(), findings=evaluate(e.spec);if(policy!==policyHash())throw Error('Policy changed');e.plan={digest:digest([e.id,e.revision,e.spec,policy]),policy,findings,created:this.now(),resources:e.spec};e.approval=undefined;e.state=findings.length?'denied':'planned';this.entries.set(id,e);this.event(a,e.state,id);return structuredClone(e);}
 revise(a:Actor,id:string,input:unknown){this.permit(a,['requester']);const e=this.get(a,id);if(e.author!==a.id||['applied','destroyed'].includes(e.state))throw Error('Forbidden transition');const spec=Request.parse(input);validate(spec);for(const other of this.entries.values())if(other.id!==id&&other.tenant===a.tenant&&other.state!=='destroyed'&&overlaps(spec.cidr,other.spec.cidr))throw Error('Network reservation overlaps');e.spec=spec;e.revision++;e.state='submitted';e.plan=undefined;e.approval=undefined;this.entries.set(id,e);this.event(a,'revise',id);return e;}
 approve(a:Actor,id:string,hash:string){this.permit(a,['approver']);const e=this.get(a,id);if(a.id===e.author||e.state!=='planned'||!e.plan||hash!==e.plan.digest||this.now()-e.plan.created>900000||e.plan.policy!==policyHash())throw Error('Approval rejected');e.approval={actor:a.id,digest:hash};e.state='approved';this.entries.set(id,e);this.event(a,'approve',id);return e;}
 apply(a:Actor,id:string,hash:string){this.permit(a,['operator']);const e=this.get(a,id);if(e.state==='applied'&&e.plan?.digest===hash)return e;if(e.state!=='approved'||!e.plan||hash!==e.plan.digest||e.approval?.digest!==hash||this.now()-e.plan.created>900000||e.plan.policy!==policyHash()||evaluate(e.spec).length)throw Error('Apply rejected');e.inventory=structuredClone(e.spec);e.state='applied';this.entries.set(id,e);this.event(a,'apply-local-simulation',id);return e;}
 destroy(a:Actor,id:string){this.permit(a,['operator']);const e=this.get(a,id);if(e.state==='destroyed')return e;if(e.state!=='applied')throw Error('Invalid transition');e.inventory=undefined;e.state='destroyed';this.entries.set(id,e);this.event(a,'destroy-local-simulation',id);return e;}
}
