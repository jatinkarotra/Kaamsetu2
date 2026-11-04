'use strict';
/* KaamSetu server: serves the site from /public and the /api used by it.
   No framework. Optional dependency: "pg" (only used when DATABASE_URL is set). */
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const E=process.env,PROD=E.NODE_ENV==='production',PORT=+E.PORT||3000;
const SECRET=E.SECRET||(PROD?'':'dev-secret-change-me');
if(!SECRET){console.error('SECRET is required in production.');process.exit(1)}
const OTP=E.OTP_PROVIDER||(E.TWILIO_VERIFY_SID?'twilio':PROD?'':'dev');
if(!OTP){console.error('Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SID (or OTP_PROVIDER=dev for testing only).');process.exit(1)}
if(OTP==='dev')console.warn('!! OTP_PROVIDER=dev: the code 123456 works for every number. Testing only.');
const PLANS={Starter:{rs:499,credits:20},Professional:{rs:999,credits:50}};
const err=(m,s=400)=>Object.assign(new Error(m),{status:s});

/* ---------- storage: Postgres (DATABASE_URL) or a JSON file ---------- */
const FILE=E.DATA_FILE||path.join(__dirname,'data.json');let db,pool;
const fresh=()=>({n:{w:1,b:1,s:1,v:1},workers:[],biz:[],sel:[],inv:[],users:{},contacts:[],paid:{}});
async function load(){
 if(E.DATABASE_URL){const{Pool}=require('pg');pool=new Pool({connectionString:E.DATABASE_URL,ssl:/@[^/]*\./.test(E.DATABASE_URL)?{rejectUnauthorized:false}:false});
  await pool.query('create table if not exists kv(k text primary key,v jsonb not null)');
  const r=await pool.query("select v from kv where k='db'");db=r.rows[0]&&r.rows[0].v}
 else try{db=JSON.parse(fs.readFileSync(FILE,'utf8'))}catch(e){}
 db=Object.assign(fresh(),db||{})}
let q=Promise.resolve();
const save=()=>q=q.then(async()=>{const s=JSON.stringify(db);
 if(pool)await pool.query("insert into kv(k,v) values('db',$1) on conflict(k) do update set v=excluded.v",[s]);
 else{fs.writeFileSync(FILE+'.tmp',s);fs.renameSync(FILE+'.tmp',FILE)}}).catch(e=>console.error('SAVE FAILED',e.message));

/* ---------- tokens, rate limits ---------- */
const sig=p=>crypto.createHmac('sha256',SECRET).update(p).digest('base64url');
const mint=(r,i)=>{const p=Buffer.from(JSON.stringify({r,i,e:Date.now()+30*864e5})).toString('base64url');return p+'.'+sig(p)};
function who(req){const t=(req.headers.authorization||'').replace(/^(Token|Bearer) /,'').split('.');if(t.length!==2)return null;
 const a=Buffer.from(sig(t[0])),b=Buffer.from(t[1]);if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return null;
 try{const d=JSON.parse(Buffer.from(t[0],'base64url'));return d.e>Date.now()?d:null}catch(e){return null}}
const hits=new Map();
function limit(k,max,ms){const n=Date.now(),a=(hits.get(k)||[]).filter(t=>n-t<ms);const ok=a.length<max;if(ok)a.push(n);hits.set(k,a);return ok}
setInterval(()=>{const n=Date.now();for(const[k,a]of hits)if(!a.some(t=>n-t<36e5))hits.delete(k)},6e5).unref();

/* ---------- OTP provider (swap this block for MSG91 etc.) ---------- */
const tw=(p,b)=>fetch('https://verify.twilio.com/v2/Services/'+E.TWILIO_VERIFY_SID+'/'+p,{method:'POST',headers:{Authorization:'Basic '+Buffer.from(E.TWILIO_ACCOUNT_SID+':'+E.TWILIO_AUTH_TOKEN).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(b)});
const otp={
 async send(ph){if(OTP==='dev')return;const r=await tw('Verifications',{To:'+91'+ph,Channel:'sms'});
  if(!r.ok){console.error('twilio send',r.status,await r.text());throw err('Could not send the OTP. Please try again in a minute.',502)}},
 async check(ph,code){if(OTP==='dev')return code==='123456';const r=await tw('VerificationCheck',{To:'+91'+ph,Code:code});
  if(r.status===404)return false;
  if(!r.ok){console.error('twilio check',r.status,await r.text());throw err('Could not verify the OTP. Please try again.',502)}
  return(await r.json()).status==='approved'}};

/* ---------- helpers ---------- */
const wk=i=>db.workers.find(x=>x.id===i),bz=i=>db.biz.find(x=>x.id===i);
const isHired=w=>db.sel.some(s=>s.worker===w.id&&s.status==='hired');
const outW=(w,ph)=>({id:w.id,name:w.name,skill:w.skill,city:w.city,phone:ph?w.phone:'',exp:w.exp,pay:w.pay,avail:w.avail,about:w.about,photo:w.photo||'',status:w.status,hired:isHired(w)});
const outB=b=>({id:b.id,name:b.name,city:b.city,status:b.status,plan:b.plan,credits:b.credits});
const authOut=(role,p)=>role==='admin'?{token:mint('admin',0),role,profile:{id:null,name:'Admin'}}:{token:mint(role,p.id),role,profile:{id:p.id,name:p.name}};
const str=(v,min,max,m)=>{v=String(v==null?'':v).trim();if(v.length<min||v.length>max)throw err(m);return v};
const same=(a,b)=>{a=Buffer.from(String(a));b=Buffer.from(String(b));return a.length===b.length&&crypto.timingSafeEqual(a,b)};
function cur(u,role){if(!u)throw err('Please log in.',401);if(role&&u.r!==role)throw err('Not allowed.',403);
 if(u.r==='admin')return{role:'admin',name:'Admin'};const p=u.r==='worker'?wk(u.i):bz(u.i);if(!p)throw err('Please log in.',401);return{role:u.r,id:p.id,p,name:p.name}}
const bot=q=>{q=String(q||'').toLowerCase();
 if(/[\u0900-\u097F]/.test(q))return 'प्रोफाइल बनाएं: "मला काम हवे" दाबा, मोबाइल नंबर आणि OTP टाका, नाव, काम, शहर, फोटो व पगार भरा. मालक तुम्हाला फोन करतील.';
 if(/credit/.test(q))return 'Each time a business selects an employee it uses 1 contact credit and unlocks their phone number. Free gives 3 credits, Starter 20 and Professional 50 every month.';
 if(/plan|price|pricing|cost|pay|₹|rupee/.test(q))return 'Plans: Free ₹0 (3 credits), Starter ₹499/month (20 credits), Professional ₹999/month (50 credits). Employees never pay.';
 if(/regist|sign ?up|join|account|create|profile|login|log in|otp/.test(q))return 'Tap "Sign up", enter your mobile number, get an OTP by SMS and fill in your details. It takes about a minute.';
 if(/hire|find|employee|worker|staff/.test(q))return 'Sign up as a business, open "Find workers", filter by job and city, then press "Hire this worker". Their number unlocks in "My workers".';
 if(/verif/.test(q))return 'Our team checks every profile and business. Verified ones carry a badge, and employee numbers unlock only for verified businesses.';
 return 'I can help with registering, contact credits, plans and hiring. What would you like to know?'};

/* ---------- body parsing ---------- */
const readBody=(req,max)=>new Promise((ok,no)=>{let n=0;const c=[];req.on('data',d=>{n+=d.length;if(n>max){no(err('Too large.',413));req.destroy()}else c.push(d)});req.on('end',()=>ok(Buffer.concat(c)));req.on('error',no)});
function multipart(buf,ct){const m=/boundary=(?:"([^"]+)"|([^;]+))/.exec(ct);if(!m)throw err('Bad form.');const b=Buffer.from('--'+(m[1]||m[2])),d={};
 let i=buf.indexOf(b);while(i>=0){const j=buf.indexOf(b,i+b.length);if(j<0)break;const part=buf.subarray(i+b.length+2,j-2),h=part.indexOf('\r\n\r\n');
  if(h>0){const head=part.subarray(0,h).toString(),body=part.subarray(h+4),n=/name="([^"]+)"/.exec(head),t=/content-type:\s*(\S+)/i.exec(head);if(n)d[n[1]]=t?{type:t[1],buf:body,size:body.length}:body.toString()}i=j}
 return{get:k=>d[k]}}

/* ---------- routes ---------- */
async function route(m,p,b,u,req,raw){
 const k=m+' '+p,ip=(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();let x;
 if(k==='GET /health')return{ok:true};
 if(k==='GET /workers')return db.workers.filter(w=>w.status!=='hidden').map(w=>outW(w,false));
 if(k==='POST /auth/otp/send'){
  const ph=String(b.phone||''),role=b.role;if(!/^[6-9]\d{9}$/.test(ph))throw err('Enter a valid mobile number.');
  const busy=()=>err('Too many OTP requests. Please wait a minute and try again.',429);
  if(!limit('si:'+ip,40,36e5))throw busy();
  const has=!!db.users[ph];
  if(b.purpose==='login'&&!has)throw err('No account found with this number. Please sign up first.');
  if(b.purpose==='register'&&has)throw err('This number is already registered. Please log in.');
  if(b.purpose==='register'&&!['worker','biz'].includes(role))throw err('Choose employee or business.');
  if(!limit('sc:'+ph,1,30e3)||!limit('s:'+ph,5,36e5))throw busy();
  await otp.send(ph);return{}}
 if(k==='POST /auth/otp/verify'){
  const ph=String(b.phone||''),code=String(b.otp||'');
  if(!/^[6-9]\d{9}$/.test(ph)||!/^\d{6}$/.test(code))throw err('Enter the 6-digit OTP.');
  if(!limit('v:'+ph,6,6e5))throw err('Too many wrong attempts. Please request a new OTP later.',429);
  if(!(await otp.check(ph,code)))throw err('Wrong or expired OTP.',400);
  let o=db.users[ph];
  if(!o){
   if(b.purpose!=='register')throw err('No account found with this number. Please sign up first.');
   const role=b.role;if(!['worker','biz'].includes(role))throw err('Choose employee or business.');
   const name=str(b.name,2,60,'Enter your name.'),city=str(b.city,2,40,'Enter your city.');let pr;
   if(role==='worker'){pr={id:db.n.w++,name,skill:str(b.skill,2,40,'Choose your job.'),city,phone:ph,exp:0,pay:'',avail:'Available now',about:'',photo:'',status:'pending'};db.workers.push(pr)}
   else{pr={id:db.n.b++,name,city,phone:ph,status:'pending',plan:'Free',credits:3};db.biz.push(pr)}
   o=db.users[ph]={role,id:pr.id};await save()}
  return authOut(o.role,o.role==='worker'?wk(o.id):bz(o.id))}
 if(k==='POST /auth/login'){
  if(!limit('l:'+ip,10,9e5))throw err('Too many attempts. Please wait and try again.',429);
  if(E.ADMIN_USER&&E.ADMIN_PASSWORD&&same(b.phone,E.ADMIN_USER)&&same(b.password,E.ADMIN_PASSWORD))return authOut('admin');
  throw err('Wrong username or password.',401)}
 if(k==='GET /me'){const c=cur(u);return{role:c.role,profile:{id:c.role==='admin'?null:c.id,name:c.name}}}
 if(k==='GET /me/worker')return outW(cur(u,'worker').p,true);
 if(k==='PATCH /me/worker'){
  const w=cur(u,'worker').p,f=b;if(!f||!f.get)return outW(w,true);
  const n={name:str(f.get('name')||w.name,2,60,'Enter your name.'),skill:str(f.get('skill')||w.skill,2,40,'Choose your job.'),city:str(f.get('city')||w.city,2,40,'Enter your city.'),
   exp:Math.min(60,Math.max(0,parseInt(f.get('exp'),10)||0)),pay:str(f.get('pay')||'',0,40,'Pay is too long.'),avail:str(f.get('avail')||w.avail,1,30,'Bad availability.'),about:str(f.get('about')||'',0,500,'About is too long (500 letters).')};
  const ph=String(f.get('phone')||'').replace(/\D/g,'').slice(-10);if(/^[6-9]\d{9}$/.test(ph))n.phone=ph;
  const pf=f.get('photo');if(pf&&pf.size){if(!/^image\/(jpeg|png|webp)$/.test(pf.type)||pf.size>3e5)throw err('Photo must be a JPG, PNG or WebP under 300 KB.');n.photo='data:'+pf.type+';base64,'+pf.buf.toString('base64')}
  Object.assign(w,n);
  await save();return outW(w,true)}
 if(k==='GET /me/chosen'){const c=cur(u,'worker');return db.sel.filter(s=>s.worker===c.id).map(s=>({id:s.id,business:outB(bz(s.biz)),status:s.status}))}
 if(k==='GET /me/business')return outB(cur(u,'biz').p);
 if(k==='GET /selections'){const c=cur(u);if(c.role==='worker')throw err('Not allowed.',403);const open=c.role==='admin'||c.p.status==='verified';
  return db.sel.filter(s=>c.role==='admin'||s.biz===c.id).map(s=>({id:s.id,business:s.biz,worker:outW(wk(s.worker),open),status:s.status}))}
 if(k==='POST /selections'){
  const c=cur(u,'biz'),B=c.p,w=wk(+b.worker);
  if(B.status!=='verified')throw err('Selection unlocks once our team verifies your business.',403);
  if(!w||w.status==='hidden')throw err('This profile is no longer available.',404);
  if(db.sel.some(s=>s.biz===B.id&&s.worker===w.id&&s.status!=='released'))throw err('You already selected this person.');
  if(B.credits<1)throw err('No contact credits left. Choose a plan to get more.',402);
  B.credits--;db.sel.push({id:db.n.s++,biz:B.id,worker:w.id,status:'selected'});await save();return{}}
 if(m==='PATCH'&&(x=p.match(/^\/selections\/(\d+)$/))){
  const c=cur(u,'biz'),s=db.sel.find(y=>y.id===+x[1]&&y.biz===c.id);if(!s)throw err('Not found.',404);
  if(!['selected','hired','released'].includes(b.status))throw err('Bad status.');s.status=b.status;await save();return{}}
 if(k==='GET /billing'){const c=cur(u,'biz');return{invoices:db.inv.filter(v=>v.biz===c.id).map(v=>({id:v.id,plan:v.plan,amount:v.amount,status:v.status}))}}
 if(k==='POST /billing'){const B=cur(u,'biz').p;
  if(b.plan==='Free'){B.plan='Free';await save();return{}}
  if(E.ALLOW_FAKE_PAYMENTS==='1'&&!PROD&&PLANS[b.plan]){B.plan=b.plan;B.credits=PLANS[b.plan].credits;await save();return{}}
  throw err('Please pay with the plan link to switch plans.',402)}
 if(k==='POST /billing/link'){
  const B=cur(u,'biz').p,pl=PLANS[b.plan];if(!pl)throw err('Unknown plan.');
  if(!E.RAZORPAY_KEY_ID||!E.RAZORPAY_KEY_SECRET)throw err('Online payment is not set up yet.',501);
  const r=await fetch('https://api.razorpay.com/v1/payment_links',{method:'POST',headers:{Authorization:'Basic '+Buffer.from(E.RAZORPAY_KEY_ID+':'+E.RAZORPAY_KEY_SECRET).toString('base64'),'Content-Type':'application/json'},
   body:JSON.stringify({amount:pl.rs*100,currency:'INR',description:'KaamSetu '+b.plan+' plan',reference_id:'b'+B.id+'-'+b.plan+'-'+Date.now(),notes:{biz:String(B.id),plan:b.plan},callback_url:E.PUBLIC_URL||undefined,callback_method:E.PUBLIC_URL?'get':undefined})});
  const d=await r.json().catch(()=>({}));if(!r.ok||!d.short_url){console.error('razorpay',r.status,JSON.stringify(d));throw err('Could not create the payment link. Try again.',502)}
  return{short_url:d.short_url}}
 if(k==='POST /razorpay/webhook'){
  if(!E.RAZORPAY_WEBHOOK_SECRET)throw err('Not configured.',501);
  const good=crypto.createHmac('sha256',E.RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex');
  if(!same(good,req.headers['x-razorpay-signature']||''))throw err('Bad signature.',400);
  const ev=JSON.parse(raw.toString()),pe=ev.payload&&ev.payload.payment_link&&ev.payload.payment_link.entity;
  if(ev.event==='payment_link.paid'&&pe&&!db.paid[pe.id]){const n=pe.notes||{},B=bz(+n.biz),pl=PLANS[n.plan];
   if(B&&pl&&pe.amount_paid>=pl.rs*100){db.paid[pe.id]=1;B.plan=n.plan;B.credits=pl.credits;db.inv.push({id:db.n.v++,biz:B.id,plan:n.plan,amount:pl.rs,status:'paid'});await save()}}
  return{ok:true}}
 if(k==='GET /admin/workers'){cur(u,'admin');return db.workers.map(w=>outW(w,true))}
 if(k==='GET /admin/businesses'){cur(u,'admin');return db.biz.map(outB)}
 if(k==='GET /admin/invoices'){cur(u,'admin');return db.inv.map(v=>({id:v.id,business:v.biz,plan:v.plan,amount:v.amount,status:v.status}))}
 if(m==='PATCH'&&(x=p.match(/^\/admin\/(workers|businesses)\/(\d+)$/))){
  cur(u,'admin');const t=(x[1]==='workers'?wk:bz)(+x[2]);if(!t)throw err('Not found.',404);
  if(!['pending','verified','hidden','suspended','rejected'].includes(b.status))throw err('Bad status.');t.status=b.status;await save();return{}}
 if(k==='POST /contact'){
  if(!limit('c:'+ip,5,36e5))throw err('Too many messages. Please try later.',429);
  db.contacts.push({t:Date.now(),name:str(b.name,1,80,'Enter your name.'),phone:str(b.phone,0,20,'Bad phone.'),message:str(b.message,1,1000,'Message is too long.')});
  if(db.contacts.length>500)db.contacts.shift();await save();return{}}
 if(k==='POST /chat'){const ms=Array.isArray(b.messages)?b.messages:[];return{reply:bot((ms[ms.length-1]||{}).content)}}
 throw err('Not found.',404)}

async function api(req,res,url){
 const send=(s,d)=>{res.writeHead(s,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(d))};
 try{
  const p=url.pathname.slice(4).replace(/\/+$/,'')||'/',ct=req.headers['content-type']||'';
  const raw=['POST','PATCH','PUT'].includes(req.method)?await readBody(req,/multipart/.test(ct)?6e5:1e5):Buffer.alloc(0);
  let b={};if(raw.length)b=/multipart/.test(ct)?multipart(raw,ct):(()=>{try{return JSON.parse(raw.toString())}catch(e){throw err('Bad request.')}})();
  const d=await route(req.method,p,b,who(req),req,raw);send(200,d)}
 catch(e){if(!e.status)console.error(e);send(e.status||500,{detail:e.status?e.message:'Something went wrong.'})}}

/* ---------- static site ---------- */
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon','.webp':'image/webp','.txt':'text/plain','.json':'application/json'};
const PUB=path.join(__dirname,'public');
function site(req,res,url){
 let f=path.normalize(path.join(PUB,decodeURIComponent(url.pathname)));
 if(!f.startsWith(PUB))f=path.join(PUB,'index.html');
 if(!fs.existsSync(f)||fs.statSync(f).isDirectory())f=path.join(PUB,'index.html');
 const t=MIME[path.extname(f)]||'application/octet-stream';
 res.writeHead(200,{'Content-Type':t,'Cache-Control':t.startsWith('text/html')?'no-cache':'public, max-age=86400'});fs.createReadStream(f).pipe(res)}

const srv=http.createServer((req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
 if(PROD&&req.headers['x-forwarded-proto']==='http'){res.writeHead(301,{Location:'https://'+req.headers.host+req.url});return res.end()}
 const url=new URL(req.url,'http://x');
 if(url.pathname.startsWith('/api/'))return api(req,res,url);
 if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);return res.end()}
 site(req,res,url)});
module.exports=srv;
if(require.main===module)load().then(()=>srv.listen(PORT,()=>console.log('KaamSetu on :'+PORT+' · OTP='+OTP+' · store='+(pool?'postgres':'file')))).catch(e=>{console.error('Startup failed:',e.message);process.exit(1)});
module.exports.load=load;
