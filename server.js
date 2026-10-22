require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const Database = require('better-sqlite3');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATABASE_DIR || __dirname;
const isProduction = process.env.NODE_ENV === 'production';
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32 || /troque-/.test(process.env.SESSION_SECRET)) {
  console.error('ERRO: defina SESSION_SECRET com pelo menos 32 caracteres aleatórios no arquivo .env.');
  process.exit(1);
}
if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD || /troque-/.test(process.env.ADMIN_PASSWORD)) {
  console.error('ERRO: defina ADMIN_USERNAME e uma ADMIN_PASSWORD forte no arquivo .env.');
  process.exit(1);
}
if (isProduction && (!process.env.PUBLIC_BASE_URL || !process.env.PUBLIC_BASE_URL.startsWith('https://'))) {
  console.error('ERRO: em produção, PUBLIC_BASE_URL precisa começar com https://.');
  process.exit(1);
}
if (String(process.env.TRUST_PROXY).toLowerCase() === 'true') app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], fontSrc: ["'self'", 'https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:', 'https:'], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"]
}} }));
app.use(express.json({ limit: '20kb' }));

const db = new Database(path.join(DATA_DIR, 'store.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS orders (
 id TEXT PRIMARY KEY, customer_name TEXT NOT NULL, roblox_username TEXT NOT NULL,
 contact TEXT NOT NULL, items_json TEXT NOT NULL, total_cents INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('Pendente','Pago','Cancelado','Entregue')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inventory ( product_id TEXT PRIMARY KEY, stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0), updated_at TEXT NOT NULL );
CREATE TABLE IF NOT EXISTS audit_log (
 id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL, action TEXT NOT NULL,
 from_status TEXT, to_status TEXT, actor TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL,
 FOREIGN KEY(order_id) REFERENCES orders(id)
);
`);

// Catálogo inicial de referência pública; ajuste preços e estoque no painel antes de vender.
const PRODUCTS = {
 'bf-dragon': { id:'bf-dragon', name:"DRAGON PERM [5000 ROBUX]", game:"Blox Fruits", priceCents:21999, description:"Fruta permanente Dragon.", icon:"🐉", stock:0 },
 'bf-kitsune': { id:'bf-kitsune', name:"KITSUNE PERM [4000 ROBUX]", game:"Blox Fruits", priceCents:17599, description:"Fruta permanente Kitsune.", icon:"🦊", stock:0 },
 'bf-control': { id:'bf-control', name:"CONTROL PERM [4000 ROBUX]", game:"Blox Fruits", priceCents:17599, description:"Fruta permanente Control.", icon:"🎮", stock:0 },
 'bf-yeti': { id:'bf-yeti', name:"YETI PERM [3000 ROBUX]", game:"Blox Fruits", priceCents:13199, description:"Fruta permanente Yeti.", icon:"❄️", stock:0 },
 'bf-tiger': { id:'bf-tiger', name:"TIGER PERM [3000 ROBUX]", game:"Blox Fruits", priceCents:13199, description:"Fruta permanente Tiger.", icon:"🐆", stock:0 },
 'bf-spirit': { id:'bf-spirit', name:"SPIRIT PERM [2550 ROBUX]", game:"Blox Fruits", priceCents:11199, description:"Fruta permanente Spirit.", icon:"👻", stock:0 },
 'bf-gas': { id:'bf-gas', name:"GAS PERM [2500 ROBUX]", game:"Blox Fruits", priceCents:10999, description:"Fruta permanente Gas.", icon:"☁️", stock:0 },
 'bf-portal': { id:'bf-portal', name:"PORTAL PERM [2000 ROBUX]", game:"Blox Fruits", priceCents:8799, description:"Fruta permanente Portal.", icon:"🌀", stock:0 },
 'bf-flame': { id:'bf-flame', name:"FLAME PERM [550 ROBUX]", game:"Blox Fruits", priceCents:2499, description:"Fruta permanente Flame.", icon:"🔥", stock:0 },
 'bf-inv-kitsune': { id:'bf-inv-kitsune', name:"KITSUNE INV + GHM", game:"Blox Fruits", priceCents:4699, description:"Conta com Kitsune no inventário e Godhuman.", icon:"🦊", stock:0 },
 'bf-inv-tiger': { id:'bf-inv-tiger', name:"TIGER INV + GHM", game:"Blox Fruits", priceCents:1799, description:"Conta com Tiger no inventário e Godhuman.", icon:"🐆", stock:0 },
 'brain-secret': { id:'brain-secret', name:"Secret Lucky Block", game:"Steal a Brainrot", priceCents:999, description:"Item digital para Steal a Brainrot.", icon:"🎁", stock:0 },
 'brain-normal': { id:'brain-normal', name:"Brainrots Normais", game:"Steal a Brainrot", priceCents:999, description:"Categoria de Brainrots Normais.", icon:"🧩", stock:0 },
 'brain-gold': { id:'brain-gold', name:"Brainrots Gold", game:"Steal a Brainrot", priceCents:1099, description:"Categoria de Brainrots Gold.", icon:"🪙", stock:0 },
 'brain-rainbow': { id:'brain-rainbow', name:"Brainrots Rainbow", game:"Steal a Brainrot", priceCents:1999, description:"Categoria de Brainrots Rainbow.", icon:"🌈", stock:0 },
 'garden-seed': { id:'garden-seed', name:"Pacote de sementes", game:"Grow a Garden", priceCents:990, description:"Oferta para Grow a Garden.", icon:"🌱", stock:0 },
 'egg-rare': { id:'egg-rare', name:"Ovo raro", game:"Roube um Ovo", priceCents:790, description:"Oferta para Roube um Ovo.", icon:"🥚", stock:0 },
};
const money = cents => (cents / 100).toLocaleString('pt-BR', { style:'currency', currency:'BRL' });
const now = () => new Date().toISOString();
const initStock = db.prepare('INSERT OR IGNORE INTO inventory (product_id,stock,updated_at) VALUES (?,?,?)');
for (const p of Object.values(PRODUCTS)) initStock.run(p.id, 0, now());
const getStock = db.prepare('SELECT stock FROM inventory WHERE product_id=?');
const publicProducts = () => Object.values(PRODUCTS).map(p=>({...p,stock:getStock.get(p.id)?.stock ?? 0}));
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false, message: { error:'Muitas tentativas. Aguarde 15 minutos e tente novamente.' } });
const orderLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false, message: { error:'Muitos pedidos deste endereço. Tente novamente mais tarde.' } });
app.use(session({
 store: new SQLiteStore({ db: 'sessions.db', dir: DATA_DIR }),
 name: 'rstore_admin', secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false,
 cookie: { httpOnly:true, sameSite:'strict', secure:isProduction, maxAge: 8 * 60 * 60 * 1000 }
}));
function requireAdmin(req,res,next){ if(req.session && req.session.isAdmin) return next(); return res.status(401).json({error:'Autenticação de administrador necessária.'}); }
function sameOrigin(req,res,next){
 const origin=req.get('origin');
 if (!origin) return next();
 let expected;
 try { expected = new URL(process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).origin; } catch { return res.status(403).json({error:'Origem não autorizada.'}); }
 if (origin !== expected) return res.status(403).json({error:'Origem não autorizada.'});
 next();
}
app.get('/api/config', (req,res)=>res.json({
 pixKey: process.env.PIX_KEY || '', pixKeyType: process.env.PIX_KEY_TYPE || '',
 pixCopyPaste: process.env.PIX_COPY_PASTE || '',
 pixReceiverName: process.env.PIX_RECEIVER_NAME || '', pixBankName: process.env.PIX_BANK_NAME || 'Banco Inter',
 paymentConfigured: Boolean((process.env.PIX_COPY_PASTE || process.env.PIX_KEY) && process.env.PIX_RECEIVER_NAME),
 products: publicProducts().map(p=>({id:p.id,name:p.name,game:p.game,priceCents:p.priceCents,description:p.description,icon:p.icon,stock:p.stock}))
}));
app.post('/api/orders', orderLimiter, sameOrigin, (req,res)=>{
 const { customerName, robloxUsername, contact, items } = req.body || {};
 if(typeof customerName!=='string'||customerName.trim().length<2||customerName.trim().length>80) return res.status(400).json({error:'Informe seu nome (2 a 80 caracteres).'});
 if(typeof robloxUsername!=='string'||! /^[A-Za-z0-9_]{3,20}$/.test(robloxUsername.trim())) return res.status(400).json({error:'Informe um usuário Roblox válido (3 a 20 letras, números ou _).'});
 if(typeof contact!=='string'||contact.trim().length<3||contact.trim().length>120) return res.status(400).json({error:'Informe um contato válido para retorno.'});
 if(!Array.isArray(items)||items.length<1||items.length>20) return res.status(400).json({error:'Carrinho inválido.'});
 const normalized=[]; let total=0;
 for(const item of items){
  if(!item||!PRODUCTS[item.id]||!Number.isInteger(item.qty)||item.qty<1||item.qty>10) return res.status(400).json({error:'Um produto ou quantidade do carrinho é inválido.'});
  const p=PRODUCTS[item.id]; const available=getStock.get(p.id)?.stock ?? 0;
  if (available < item.qty) return res.status(409).json({error:`Estoque insuficiente para ${p.name}. Disponível: ${available}.`});
  total += p.priceCents*item.qty;
  normalized.push({id:p.id,name:p.name,game:p.game,priceCents:p.priceCents,qty:item.qty});
 }
 if(total<1||total>10000000) return res.status(400).json({error:'Valor total inválido.'});
 const id=crypto.randomUUID().replace(/-/g,'').slice(0,12).toUpperCase();
 const timestamp=now();
 const createOrder = db.transaction(()=>{
  for (const item of normalized) { const current=getStock.get(item.id)?.stock ?? 0; if(current < item.qty) throw new Error(`Estoque insuficiente para ${item.name}.`); db.prepare('UPDATE inventory SET stock=stock-?,updated_at=? WHERE product_id=?').run(item.qty,timestamp,item.id); }
  db.prepare('INSERT INTO orders (id,customer_name,roblox_username,contact,items_json,total_cents,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
   .run(id,customerName.trim(),robloxUsername.trim(),contact.trim(),JSON.stringify(normalized),total,'Pendente',timestamp,timestamp);
  db.prepare('INSERT INTO audit_log (order_id,action,from_status,to_status,actor,note,created_at) VALUES (?,?,?,?,?,?,?)').run(id,'Pedido criado',null,'Pendente','Cliente','Estoque reservado; pagamento ainda não verificado.',timestamp);
 });
 try { createOrder(); } catch(e) { return res.status(409).json({error:e.message||'Não foi possível reservar o estoque.'}); }
 res.status(201).json({orderId:id,totalCents:total,total:money(total),status:'Pendente',createdAt:timestamp,pixKey:process.env.PIX_KEY||'',pixKeyType:process.env.PIX_KEY_TYPE||'',pixCopyPaste:process.env.PIX_COPY_PASTE||'',pixReceiverName:process.env.PIX_RECEIVER_NAME||'',pixBankName:process.env.PIX_BANK_NAME||'Banco Inter',paymentConfigured:Boolean((process.env.PIX_COPY_PASTE||process.env.PIX_KEY)&&process.env.PIX_RECEIVER_NAME)});
});
app.post('/api/admin/login', loginLimiter, sameOrigin, async (req,res)=>{
 const {username,password}=req.body||{};
 if(typeof username!=='string'||typeof password!=='string') return res.status(400).json({error:'Preencha usuário e senha.'});
 const expectedUser=crypto.createHash('sha256').update(process.env.ADMIN_USERNAME).digest();
 const suppliedUser=crypto.createHash('sha256').update(username).digest();
 const okUser=crypto.timingSafeEqual(suppliedUser,expectedUser);
 const passHash=await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
 const okPass=await bcrypt.compare(password,passHash);
 if(!okUser||!okPass) return res.status(401).json({error:'Usuário ou senha incorretos.'});
 req.session.regenerate(err=>{if(err)return res.status(500).json({error:'Não foi possível iniciar a sessão.'});req.session.isAdmin=true;req.session.adminUser=process.env.ADMIN_USERNAME;req.session.save(err2=>{if(err2)return res.status(500).json({error:'Não foi possível salvar a sessão.'});res.json({ok:true,username:req.session.adminUser});});});
});
app.get('/api/admin/me', requireAdmin, (req,res)=>res.json({ok:true,username:req.session.adminUser}));
app.post('/api/admin/logout', sameOrigin, requireAdmin, (req,res)=>req.session.destroy(()=>{res.clearCookie('rstore_admin',{httpOnly:true,sameSite:'strict',secure:isProduction});res.json({ok:true});}));
app.get('/api/admin/inventory', requireAdmin, (req,res)=>res.json(publicProducts()));
app.post('/api/admin/inventory/:id', sameOrigin, requireAdmin, (req,res)=>{
 const id=req.params.id; const stock=req.body?.stock;
 if(!PRODUCTS[id]) return res.status(404).json({error:'Produto não encontrado.'});
 if(!Number.isInteger(stock)||stock<0||stock>100000) return res.status(400).json({error:'Estoque deve ser um número inteiro entre 0 e 100000.'});
 db.prepare('UPDATE inventory SET stock=?,updated_at=? WHERE product_id=?').run(stock,now(),id);
 res.json({ok:true,id,stock});
});
app.get('/api/admin/orders', requireAdmin, (req,res)=>{
 const rows=db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 500').all();
 res.json(rows.map(o=>({...o,items:JSON.parse(o.items_json),total:money(o.total_cents)})));
});
app.get('/api/admin/notifications', requireAdmin, (req,res)=>{
 const after=String(req.query.after||'');
 const row=after ? db.prepare("SELECT COUNT(*) AS count FROM orders WHERE created_at > ?").get(after) : {count:0};
 const latest=db.prepare('SELECT MAX(created_at) AS latest FROM orders').get().latest || null;
 res.json({newOrders:row.count,latest});
});
app.get('/api/admin/orders/:id/history', requireAdmin, (req,res)=>{
 const history=db.prepare('SELECT action,from_status,to_status,actor,note,created_at FROM audit_log WHERE order_id=? ORDER BY id DESC').all(req.params.id);
 res.json(history);
});
app.post('/api/admin/orders/:id/status', sameOrigin, requireAdmin, (req,res)=>{
 const {status,note}=req.body||{};
 const allowed=['Pago','Cancelado','Entregue'];
 if(!allowed.includes(status)) return res.status(400).json({error:'Status solicitado inválido.'});
 const order=db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
 if(!order) return res.status(404).json({error:'Pedido não encontrado.'});
 const transitions={Pendente:['Pago','Cancelado'],Pago:['Entregue'],Cancelado:[],Entregue:[]};
 if(!transitions[order.status].includes(status)) return res.status(409).json({error:`Não é permitido mudar de ${order.status} para ${status}.`});
 if(status==='Pago' && (!process.env.PIX_KEY || !process.env.PIX_RECEIVER_NAME)) return res.status(409).json({error:'Configure PIX_KEY e PIX_RECEIVER_NAME no servidor antes de confirmar pedidos.'});
 const timestamp=now();
 const safeNote=typeof note==='string'?note.trim().slice(0,300):'';
 const transaction=db.transaction(()=>{
  db.prepare('UPDATE orders SET status=?,updated_at=? WHERE id=?').run(status,timestamp,order.id);
  if(status==='Cancelado' && order.status==='Pendente') for(const item of JSON.parse(order.items_json)) db.prepare('UPDATE inventory SET stock=stock+?,updated_at=? WHERE product_id=?').run(item.qty,timestamp,item.id);
  db.prepare('INSERT INTO audit_log (order_id,action,from_status,to_status,actor,note,created_at) VALUES (?,?,?,?,?,?,?)')
   .run(order.id, status==='Pago'?'Pagamento confirmado manualmente':status==='Entregue'?'Pedido marcado como entregue':'Pedido cancelado',order.status,status,req.session.adminUser,safeNote || (status==='Pago'?'Administrador confirmou após verificar o crédito no aplicativo bancário.':''),timestamp);
 });
 transaction(); res.json({ok:true,id:order.id,status,updatedAt:timestamp});
});
// Publicar somente os arquivos do site; nunca servir .env, banco, código do servidor ou sessões.
app.get('/', (req,res)=>res.sendFile(path.join(__dirname,'index.html')));
app.get('/style.css', (req,res)=>res.sendFile(path.join(__dirname,'style.css')));
app.get('/script.js', (req,res)=>res.sendFile(path.join(__dirname,'script.js')));
app.get('/admin', (req,res)=>res.sendFile(path.join(__dirname,'admin.html')));
app.get('/admin.css', (req,res)=>res.sendFile(path.join(__dirname,'admin.css')));
app.get('/admin.js', (req,res)=>res.sendFile(path.join(__dirname,'admin.js')));
app.use((err,req,res,next)=>{console.error(err);if(res.headersSent)return next(err);res.status(500).json({error:'Erro interno. Consulte os logs do servidor.'});});
app.listen(PORT,()=>console.log(`Roblox Store Premium disponível em http://localhost:${PORT}`));
