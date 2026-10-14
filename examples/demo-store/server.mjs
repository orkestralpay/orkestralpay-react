// Demo store: a merchant integration example for sandbox and presentations.
// Checkout page -> the store BACKEND creates the PaymentIntent with the merchant credentials -> Orkestral checkout.
// The merchant secret and the order total stay on this server; the browser only sends item ids, quantities and
// buyer data. Not production code: no persistence, no real catalog.
// Usage: see README.md (configuration by environment variables).
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { normalize, join, dirname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export function readConfig(env = process.env) {
	const port = Number(env.PORT || 4030);
	const config = {
		port,
		publicUrl: (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
		apiUrl: (env.ORKESTRAL_API_URL || '').replace(/\/+$/, ''),
		authUrl: (env.ORKESTRAL_AUTH_URL || env.ORKESTRAL_API_URL || '').replace(/\/+$/, ''),
		checkoutUrl: (env.CHECKOUT_URL || '').replace(/\/+$/, ''),
		merchantId: env.MERCHANT_ID || '',
		clientId: env.MERCHANT_CLIENT_ID || env.MERCHANT_ID || '',
		clientSecret: env.MERCHANT_CLIENT_SECRET || '',
		username: env.MERCHANT_API_USERNAME || '',
		password: env.MERCHANT_API_PASSWORD || '',
		// Optional, local only: the PSP mock control URL enables the scenario shortcuts (decline, timeout)
		pspMockUrl: (env.PSP_MOCK_URL || '').replace(/\/+$/, ''),
		// Optional, local only: /painel (live view of how each order moved through the payment flow); reads the local Postgres containers
		panel: env.DEMO_PANEL === '1'
	};
	const missing = ['apiUrl', 'checkoutUrl', 'merchantId', 'clientSecret', 'username', 'password'].filter((k) => !config[k]);
	if (missing.length) throw new Error(`Missing configuration: ${missing.join(', ')}`);
	return config;
}

// Catalogo em centavos (o total e calculado aqui; o navegador so manda ids e quantidades)
const PRODUCTS = {
	cafe: { name: 'Café especial 250g', detail: 'Torra média, grãos', price: 4990 },
	caneca: { name: 'Caneca esmaltada', detail: '350 ml, verde', price: 5900 },
	coador: { name: 'Coador de pano', detail: 'Algodão, tamanho 103', price: 2490 }
};
const UFS = 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ');
const SAMPLE = { name: 'Joao', surname: 'Silva', document: '529.982.247-25', email: 'joao.silva@example.com', phone: '(11) 99999-9999',
	postal_code: '01001-000', street: 'Praça da Sé', number: '100', details: 'Apto 12', neighborhood: 'Sé', city: 'São Paulo', state: 'SP' };
// Atalhos de demonstracao: ajustam o mock da Cielo e abrem o checkout de um pedido com os dados de exemplo
const SCENARIOS = {
	pequena: { label: 'Compra pequena (R$ 24,90): vai direto para a Cielo', cart: { qty_cafe: 0, qty_caneca: 0, qty_coador: 1 } },
	cop: { label: 'Compra em pesos colombianos (COP): vai para a Kushki', currency: 'COP', cart: { qty_cafe: 0, qty_caneca: 0, qty_coador: 1 } },
	grande: { label: 'Compra grande (R$ 158,80): tenta a PayU e, se recusar, cai na Cielo', cart: { qty_cafe: 2, qty_caneca: 1, qty_coador: 0 } },
	aprovado: { label: 'Pagamento aprovado', mode: 'ok' },
	recusado: { label: 'Cartão recusado pela Cielo', mode: 'decline' },
	'sem-resposta': { label: 'Cielo sem resposta (resultado incerto, ~20s)', mode: 'timeout' }
};

export const brl = (cents) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const digits = (v) => String(v ?? '').replace(/\D/g, '');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function validCpf(cpf) {
	if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
	const check = (len) => {
		const sum = [...cpf.slice(0, len)].reduce((s, d, i) => s + Number(d) * (len + 1 - i), 0);
		return ((sum * 10) % 11) % 10;
	};
	return check(9) === Number(cpf[9]) && check(10) === Number(cpf[10]);
}

// Validacao no servidor da loja (fronteira de confianca): o navegador pode mandar qualquer coisa
export function readOrder(form) {
	const cart = Object.fromEntries(Object.keys(PRODUCTS).map((id) => [id, Math.max(0, Math.min(10, Number(form[`qty_${id}`]) | 0))]));
	const amount = Object.entries(cart).reduce((sum, [id, qty]) => sum + PRODUCTS[id].price * qty, 0);
	const f = Object.fromEntries(Object.keys(SAMPLE).map((k) => [k, String(form[k] ?? '').trim()]));
	const errors = [];
	if (amount <= 0) errors.push('Adicione pelo menos um produto.');
	for (const k of ['name', 'surname', 'street', 'number', 'neighborhood', 'city']) if (!f[k]) errors.push('Preencha todos os campos obrigatórios.');
	if (!validCpf(digits(f.document))) errors.push('CPF inválido.');
	if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) errors.push('E-mail inválido.');
	if (!/^\d{10,11}$/.test(digits(f.phone))) errors.push('Telefone inválido (DDD + número).');
	if (!/^\d{8}$/.test(digits(f.postal_code))) errors.push('CEP inválido.');
	if (!UFS.includes(f.state)) errors.push('Selecione o estado.');
	return { cart, amount, f, errors: [...new Set(errors)] };
}

async function merchantToken(config) {
	const r = await fetch(`${config.authUrl}/oauth2/token`, {
		method: 'POST',
		headers: { Authorization: 'Basic ' + Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64') },
		body: new URLSearchParams({ username: config.username, password: config.password, grant_type: 'password' })
	});
	if (!r.ok) throw new Error(`login do merchant: HTTP ${r.status}`);
	return (await r.json()).access_token;
}

// Demo: COP scenario sends a Colombian buyer and a fixed COP 50.000 amount (the catalog is in BRL)
const COP_BUYER = { name: 'Carlos', surname: 'Gomez', document: '1234567890', email: 'carlos@example.com', phone: '3001234567', postal_code: '110111', street: 'Calle 10', number: '5-20', details: 'Apto 1', neighborhood: 'Centro', city: 'Bogota', state: 'DC' };
async function createIntent(config, { cart, amount, f }, ip, currency = 'BRL', { card = true, bankSlipProvider } = {}) {
	const cop = currency === 'COP';
	if (cop) { amount = 5000000; f = COP_BUYER; }
	const items = Object.entries(cart).filter(([, q]) => q > 0).map(([id, q]) => `${q}x ${PRODUCTS[id].name}`).join(', ');
	const r = await fetch(`${config.apiUrl}/v1/payment-intents/${config.merchantId}`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${await merchantToken(config)}`, IP: ip, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			amount, currency, ...(card ? { payment_method: 'CREDIT_CARD' } : {}), ...(bankSlipProvider ? { bank_slip_provider: bankSlipProvider } : {}), description: `Torra & Cia: ${items}`.slice(0, 200),
			expiration: new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 19),
			origin_url: config.publicUrl, ok_url: `${config.publicUrl}/obrigado`, error_url: `${config.publicUrl}/`,
			// PIX e boleto via WePayments exigem dados do lojista e do produto; sem eles o checkout cai em ERROR
			beneficiary_sender: { name: 'Torra & Cia', document: '11222333000181', helpdesk: 'contato@example.com' },
			product_info: { id: 'pedido', title: 'Pedido Torra & Cia', description: items.slice(0, 200), category_id: 'cafe', unit_price: amount, quantity: 1 },
			client: {
				name: f.name, surname: f.surname, document_type: cop ? 'CC' : 'CPF', document_number: cop ? f.document : digits(f.document),
				telephone: digits(f.phone), email: f.email,
				billing_address: { street: f.street, number: f.number, neighborhood: f.neighborhood, country: cop ? 'CO' : 'BR', state: f.state,
					city: f.city, details: f.details || '-', postal_code: digits(f.postal_code) }
			}
		})
	});
	const body = await r.json();
	if (r.status !== 201) throw new Error(`HTTP ${r.status} ${body.message ?? ''}`);
	console.log(`intent ${body.payment_intent_id} ${cop ? 'COP ' + amount / 100 : brl(amount)} (${items})`);
	return body.payment_intent_id;
}

const page = (title, inner) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
:root{--bg:#f4f1ec;--card:#fff;--line:#e3dcd3;--fg:#2b2420;--muted:#7a6e66;--accent:#3d5a40;--bad:#a3312a}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
header{background:var(--accent);color:#fff;padding:14px 16px}header div{max-width:1040px;margin:0 auto;display:flex;justify-content:space-between;align-items:center;gap:12px}
header b{font:600 20px Georgia,serif}header span{font-size:13px;opacity:.85}
main{max-width:1040px;margin:0 auto;padding:24px 16px 48px}
h1{font:600 28px/1.2 Georgia,serif;margin:0 0 20px}h2{font:600 18px/1.3 Georgia,serif;margin:0 0 12px}
.grid{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:24px;align-items:start}
.box{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px;margin-bottom:16px}
.row{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px}
.c2{grid-column:span 2}.c3{grid-column:span 3}.c4{grid-column:span 4}.c6{grid-column:span 6}
label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--muted)}
input,select{font:inherit;color:var(--fg);padding:9px 10px;border:1px solid #cfc6bb;border-radius:6px;background:#fff;width:100%}
input:focus-visible,select:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid #9cc5a1;outline-offset:1px}
.item{display:grid;grid-template-columns:minmax(0,1fr) 64px;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line)}
.item b{display:block;font-size:15px}.item span{color:var(--muted);font-size:13px}
.sum{display:flex;justify-content:space-between;margin:6px 0;font-size:15px}.sum.total{font-weight:700;font-size:18px;margin-top:12px}
.pay{display:flex;align-items:center;gap:10px;border:2px solid var(--accent);border-radius:8px;padding:12px;background:#f2f6f2}
.pay svg{flex:none}.pay small{display:block;color:var(--muted)}
button{width:100%;padding:14px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:600 16px system-ui;cursor:pointer;margin-top:14px}
.ghost{background:none;color:var(--accent);border:1px solid var(--accent);padding:8px;font-size:14px;margin:0 0 12px}
.err{background:#f8e4e2;color:var(--bad);padding:12px 14px;border-radius:8px;margin-bottom:16px}
.muted{color:var(--muted);font-size:13px}.links{padding-left:18px;margin:6px 0 0}.links li{margin:4px 0}
a{color:var(--accent)}
@media (max-width:820px){.grid{grid-template-columns:minmax(0,1fr)}.row .c2,.row .c3,.row .c4{grid-column:span 6}}
</style></head><body><header><div><b>Torra &amp; Cia</b><span>Loja de demonstração · pagamentos Orkestral</span></div></header><main>${inner}</main></body></html>`;

const field = (name, label, cls, v, attrs = '') => `<label class="${cls}">${label}<input id="${name}" name="${name}" value="${esc(v[name])}" ${attrs}></label>`;

function checkoutPage(config, v = {}, errors = []) {
	const qty = (id) => v[`qty_${id}`] ?? 1;
	return page('Finalizar compra · Torra & Cia', `
<h1>Finalizar compra</h1>
${errors.length ? `<div class="err" role="alert">${errors.map(esc).join('<br>')}</div>` : ''}
<form method="post" action="/comprar" id="order" novalidate>
<div class="grid"><div>
<section class="box"><h2>Seus dados</h2>
<button type="button" class="ghost" id="sample">Preencher com dados de teste</button>
<div class="row">
${field('name', 'Nome *', 'c3', v, 'autocomplete="given-name" required')}
${field('surname', 'Sobrenome *', 'c3', v, 'autocomplete="family-name" required')}
${field('document', 'CPF *', 'c2', v, 'inputmode="numeric" placeholder="000.000.000-00" required')}
${field('phone', 'Celular com DDD *', 'c2', v, 'type="tel" autocomplete="tel" placeholder="(11) 99999-9999" required')}
${field('email', 'E-mail *', 'c2', v, 'type="email" autocomplete="email" required')}
</div></section>
<section class="box"><h2>Endereço de cobrança</h2><div class="row">
${field('postal_code', 'CEP *', 'c2', v, 'inputmode="numeric" autocomplete="postal-code" placeholder="00000-000" required')}
${field('street', 'Rua *', 'c4', v, 'autocomplete="address-line1" required')}
${field('number', 'Número *', 'c2', v, 'required')}
${field('details', 'Complemento', 'c4', v, 'autocomplete="address-line2"')}
${field('neighborhood', 'Bairro *', 'c2', v, 'required')}
${field('city', 'Cidade *', 'c2', v, 'autocomplete="address-level2" required')}
<label class="c2">Estado *<select id="state" name="state" required><option value="">Selecione</option>${UFS.map((u) => `<option${v.state === u ? ' selected' : ''}>${u}</option>`).join('')}</select></label>
</div></section>
<section class="box"><h2>Pagamento</h2>
<div class="pay"><svg width="34" height="24" viewBox="0 0 34 24" aria-hidden="true"><rect width="34" height="24" rx="4" fill="#3d5a40"/><rect y="6" width="34" height="4" fill="#f4f1ec"/><rect x="5" y="15" width="10" height="3" rx="1" fill="#f4f1ec"/></svg>
<div><b>Cartão de crédito</b><small>Você digita o cartão na próxima tela, no ambiente seguro da Orkestral.</small></div></div>
</section>
</div>
<aside class="box"><h2>Seu pedido</h2>
${Object.entries(PRODUCTS).map(([id, p]) => `<div class="item"><div><b>${p.name}</b><span>${p.detail} · ${brl(p.price)}</span></div>
<label>Qtd<input type="number" id="qty_${id}" name="qty_${id}" min="0" max="10" value="${esc(qty(id))}" data-price="${p.price}"></label></div>`).join('')}
<div class="sum"><span>Subtotal</span><span id="subtotal"></span></div>
<div class="sum"><span>Frete</span><span>Grátis</span></div>
<div class="sum total"><span>Total</span><span id="total"></span></div>
<button type="submit">Ir para o pagamento</button>
<p class="muted">Ao continuar, você será levado ao checkout seguro para pagar com cartão de crédito.</p>
</aside></div></form>
${config.pspMockUrl ? `<section class="box"><h2>Atalhos para a demonstração</h2>
<p class="muted">Criam um pedido (1 café) com os dados de teste e abrem o checkout. Cartão de teste: 4024 0071 9769 2931, validade 12/30, CVV 123.</p>
<ul class="links">${Object.entries(SCENARIOS).map(([id, sc]) => `<li><a href="/cenario/${id}">${sc.label}</a></li>`).join('')}
<li>Mesmo pedido em duas abas: depois de "Ir para o pagamento", copie o endereço do checkout e abra em outra aba</li></ul></section>` : ''}
<script>
const f=document.getElementById('order'),fmt=c=>(c/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const upd=()=>{let s=0;f.querySelectorAll('[data-price]').forEach(i=>s+=i.dataset.price*(+i.value||0));document.getElementById('subtotal').textContent=fmt(s);document.getElementById('total').textContent=fmt(s)};
f.addEventListener('input',upd);upd();
document.getElementById('sample').addEventListener('click',()=>{const d=${JSON.stringify(SAMPLE)};for(const k in d){const el=document.getElementById(k);if(el)el.value=d[k]}});
</script>`);
}

const ip = (req) => req.socket.remoteAddress?.replace('::ffff:', '') || '127.0.0.1';
const html = (res, status, body) => res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(body);

// Local demo only: the payment flow decisions are not exposed by an API, so the panel reads the Postgres containers.
const psql = (container, db, sql) => new Promise((resolve, reject) =>
	execFile('docker', ['exec', container, 'psql', '-U', 'ldb_user', '-d', db, '-At', '-c', sql], { timeout: 8000 }, (e, out) => (e ? reject(e) : resolve(out.trim()))));

// The panel starts empty each time the store starts (clean slate for a presentation)
const PANEL_SINCE = new Date().toISOString();

// Calls whose body carries no order id (Kushki, Payvalida) belong to the latest order created before the call, within 3 minutes
function callsOf(orderId, orders) {
	const created = (o) => Date.parse(o.created_at);
	return pspCalls.filter((c) => {
		if (c.order) return c.order === orderId;
		const at = Date.parse(c.at);
		const owner = orders.filter((o) => created(o) <= at && at <= created(o) + 180000).sort((a, b) => created(b) - created(a))[0];
		return owner?.id === orderId;
	});
}

async function panelData(config) {
	const orders = await psql('payment-service-db', 'payment_service_db',
		`select coalesce(json_agg(o), '[]') from (select t.id, t.amount, t.currency, pm.name as method, to_char(t.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at, to_char(t.payment_intent_expires_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as expires_at, s.name as status, t.psp_name as psp, t.description,
		 (select json_agg(json_build_object('t', to_char(h.create_date, 'HH24:MI:SS'), 'status', ps.name, 'descr', h.description) order by h.create_date)
		  from payment_status_history h join payment_status ps using (payment_status_id) where h.transaction_id = t.id) as hist
		 from transaction t join payment_status s using (payment_status_id) left join payment_method pm on pm.payment_method_id = t.payment_method_id
		 where t.merchant_id = '${config.merchantId}' and t.description like 'Torra & Cia%' and t.created_at >= ('${PANEL_SINCE}'::timestamptz at time zone 'utc') order by t.created_at desc limit 8) o`);
	// the VALUE rule may sit under other conditions (e.g. currency), so walk the active card flow tree
	const rule = await psql('management-service-db', 'management_service_db',
		`with recursive t as (
		   select r.id, r.rule_type_id, r.condition_value, r.next_rule_if_true_id n1, r.next_rule_if_false_id n2
		   from payment_flow f join rules r on r.id = f.rule_id join payment_method pm on pm.id = f.payment_method_type_id
		   where f.active and pm.name = 'CREDIT_CARD' and f.merchant_id = '${config.merchantId}'
		   union
		   select r.id, r.rule_type_id, r.condition_value, r.next_rule_if_true_id, r.next_rule_if_false_id from rules r join t on r.id in (t.n1, t.n2))
		 select t.condition_value from t join rule_type rt using (rule_type_id) where rt.rule = 'VALUE' limit 1`);
	// name of the active flow per payment method, so the panel can say which flow it is drawing
	const flowRows = await psql('management-service-db', 'management_service_db',
		`select coalesce(json_object_agg(pm.name, f.name), '{}') from payment_flow f join payment_method pm on pm.id = f.payment_method_type_id
		 where f.active and f.merchant_id = '${config.merchantId}'`);
	// active flow of each payment method as a rule tree (decisions, PSPs in priority order, equalizer splits), so the panel draws what the router really runs
	const trees = await psql('management-service-db', 'management_service_db',
		`with recursive t as (
		   select f.id as flow_id, f.rule_id as id from payment_flow f where f.active and f.merchant_id = '${config.merchantId}' and f.rule_id is not null
		   union
		   select t.flow_id, x.id from t join rules r on r.id = t.id
		   cross join lateral (select r.next_rule_if_true_id union select r.next_rule_if_false_id union select q.next_rule_id from equalizer q where q.rule_id = r.id) x(id)
		   where x.id is not null)
		 select coalesce(json_object_agg(s.method, s.tree), '{}') from (
		   select pm.name as method, json_build_object('name', f.name, 'root', f.rule_id, 'nodes', json_object_agg(r.id, json_build_object(
		     't', rt.rule, 'op', ot.operation, 'v', r.condition_value, 'y', r.next_rule_if_true_id, 'n', r.next_rule_if_false_id,
		     'psps', (select json_agg(p.name order by e.priority) from pay_process_execution e join psp p on p.id = e.psp_id where e.rule_id = r.id),
		     'eq', (select json_agg(json_build_object('v', q.value, 'to', q.next_rule_id)) from equalizer q where q.rule_id = r.id)))) as tree
		   from t join payment_flow f on f.id = t.flow_id join payment_method pm on pm.id = f.payment_method_type_id
		   join rules r on r.id = t.id join rule_type rt using (rule_type_id) left join operator_type ot using (operator_type_id)
		   group by pm.name, f.name, f.rule_id) s`);
	const list = JSON.parse(orders);
	// PSP attempts per order (from the recording proxy; bodies without the order id are attached by time window)
	for (const o of list) o.attempts = callsOf(o.id, list).map((c) => ({ psp: c.psp, ok: c.ok, text: c.text, path: c.path }));
	return { threshold: Number(JSON.parse(rule || '["0"]')[0]), flows: JSON.parse(flowRows || '{}'), trees: JSON.parse(trees || '{}'), orders: list };
}

// Local demo only: recording forward proxy for the PSP calls (integrator -> PSP), so the panel can show what was sent and received.
// It forwards untouched to the PSP sandbox; only the stored copy is masked (card, CVV, keys, signatures).
const PSP_TARGETS = {
	cielo: { write: 'https://apisandbox.cieloecommerce.cielo.com.br', read: 'https://apiquerysandbox.cieloecommerce.cielo.com.br' },
	payu: { write: 'https://sandbox.api.payulatam.com', read: 'https://sandbox.api.payulatam.com' },
	kushki: { write: 'https://api-uat.kushkipagos.com', read: 'https://api-uat.kushkipagos.com' },
	payvalida: { write: 'https://api-test.payvalida.com', read: 'https://api-test.payvalida.com' },
	wepayments: { write: 'https://api.sandbox.wepayout.com.br', read: 'https://api.sandbox.wepayout.com.br' }
};
const pspCalls = [];
const paymentOwner = new Map(); // Cielo PaymentId -> order id (void and query calls only carry the PaymentId)
const SECRET_KEY = /^(securitycode|cvv|expirationdate|merchantkey|apikey|apilogin|signature|password|token|cardtoken|publickey)$/i;
const CARD_KEY = /^(number|cardnumber)$/i;
const last4 = (n) => `**** **** **** ${String(n).replace(/\D/g, '').slice(-4)}`;
export function mask(v) {
	if (Array.isArray(v)) return v.map(mask);
	if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, CARD_KEY.test(k) && typeof x === 'string' && /^\d{13,19}$/.test(x.replace(/\D/g, '')) && x.replace(/\D/g, '').length === x.replace(/[\s-]/g, '').length ? last4(x) : SECRET_KEY.test(k) ? '***' : mask(x)]));
	return typeof v === 'string' ? v.replace(/\b\d{13,19}\b/g, (n) => `**** ${n.slice(-4)}`) : v;
}
const parse = (t) => { try { return JSON.parse(t); } catch { return t ? String(t).slice(0, 2000) : null; } };
const dashed = (h) => (/^[0-9a-f]{32}$/i.test(h) ? `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` : null);
function summarize(psp, status, res) {
	if (psp === 'cielo') {
		if (Array.isArray(res)) return { ok: false, text: res.map((e) => `${e.Code}: ${e.Message}`).join('; ') };
		const p = res?.Payment;
		if (p) return { ok: [1, 2].includes(p.Status), text: `Status ${p.Status}${p.ReturnCode ? ` · ${p.ReturnCode}` : ''}${p.ReturnMessage ? ` · ${p.ReturnMessage}` : ''}` };
	} else {
		const t = res?.transactionResponse;
		if (t) return { ok: t.state === 'APPROVED', text: `${t.state}${t.responseCode ? ` · ${t.responseCode}` : ''}${t.paymentNetworkResponseErrorMessage ? ` · ${t.paymentNetworkResponseErrorMessage}` : ''}` };
		if (res?.code) return { ok: res.code === 'SUCCESS', text: `${res.code}${res.error ? ` · ${res.error}` : ''}` };
	}
	const msg = res && typeof res === 'object' ? (res.message ?? res.error ?? res.DESC ?? res.code ?? res.CODE) : null;
	return { ok: status < 400, text: `HTTP ${status}${msg ? ` · ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`.slice(0, 160) : ''}` };
}
async function pspProxy(req, res, raw) {
	const [, , name, ...rest] = req.url.split('/');
	const target = PSP_TARGETS[name];
	if (!target) return res.writeHead(404).end();
	const path = '/' + rest.join('/');
	const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'content-length', 'connection', 'accept-encoding', 'expect', 'transfer-encoding', 'keep-alive'].includes(k)));
	const started = Date.now();
	const reqJson = parse(raw);
	let status = 502, text = '', ctype = 'application/json';
	try {
		const r = await fetch((req.method === 'GET' ? target.read : target.write) + path, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw, signal: AbortSignal.timeout(60000) });
		status = r.status; text = await r.text(); ctype = r.headers.get('content-type') || ctype;
	} catch (e) { text = JSON.stringify({ proxyError: e.message }); }
	const resJson = parse(text);
	const paymentId = name === 'cielo' ? path.match(/^\/1\/sales\/([^/?]+)/)?.[1] : null;
	let order = reqJson?.MerchantOrderId ?? dashed(reqJson?.transaction?.order?.referenceCode) ?? (paymentId && paymentOwner.get(paymentId)) ?? null;
	if (!order && reqJson && typeof reqJson === 'object') order = JSON.stringify(reqJson).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ?? null;
	if (order && resJson?.Payment?.PaymentId) paymentOwner.set(resJson.Payment.PaymentId, order);
	pspCalls.push({ id: pspCalls.length + 1, at: new Date().toISOString(), psp: name, method: req.method, path, status, ms: Date.now() - started, order, ...summarize(name, status, resJson), req: mask(reqJson), res: mask(resJson) });
	if (pspCalls.length > 200) pspCalls.shift();
	res.writeHead(status, { 'Content-Type': ctype }).end(text);
}

// PIX / boleto / PSE scenarios: the store creates the order without a method and then selects it, as the checkout does on click
const METHOD_SCENARIOS = {
	pix: { methodId: 5, currency: 'BRL' },
	'boleto-brl': { methodId: 3, currency: 'BRL' },
	// boleto with a bank_slip_provider only works through the direct payin API: the "choose the method later" flow drops that field
	'boleto-cop': { methodId: 3, currency: 'COP', bankSlipProvider: 'Efecty', direct: 'CASH' },
	'pse-cop': { methodId: 4, currency: 'COP' }
};
async function launchMethod(config, key, ip) {
	const sc = METHOD_SCENARIOS[key];
	const cart = { qty_cafe: 0, qty_caneca: 0, qty_coador: 1 };
	if (sc.direct) {
		const id = randomUUID(), amount = 5000000, f = COP_BUYER;
		const r = await fetch(`${config.apiUrl}/transaction/payin/${config.merchantId}`, {
			method: 'POST', headers: { Authorization: `Bearer ${await merchantToken(config)}`, IP: ip, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(90000),
			body: JSON.stringify({ transaction_id: id, amount, currency: sc.currency, description: 'Torra & Cia: boleto em COP', payment_method: sc.direct,
				expiration: new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 19), bank_slip_provider: sc.bankSlipProvider,
				beneficiary_sender: { name: 'Torra & Cia', document: '11222333000181', helpdesk: 'contato@example.com' },
				product_info: { id: 'pedido', title: 'Pedido Torra & Cia', description: 'Cafe', category_id: 'cafe', unit_price: amount, quantity: 1 },
				client: { name: f.name, surname: f.surname, document_type: 'CC', document_number: f.document, telephone: f.phone, email: f.email,
					billing_address: { street: f.street, number: f.number, neighborhood: f.neighborhood, country: 'CO', state: f.state, city: f.city, details: f.details, postal_code: f.postal_code } } })
		});
		return { id, status: r.status };
	}
	const id = await createIntent(config, readOrder({ ...SAMPLE, ...cart }), ip, sc.currency, { card: false, bankSlipProvider: sc.bankSlipProvider });
	const r = await fetch(`${config.apiUrl}/integrator/transaction/${id}`, { method: 'PUT', headers: { IP: ip, 'Content-Type': 'application/json' }, body: JSON.stringify({ payment_method_id: sc.methodId }), signal: AbortSignal.timeout(90000) });
	return { id, status: r.status };
}

export function createStoreServer(config) {
	return createServer(async (req, res) => {
	let form = {};
	try {
		if (config.panel && req.url.startsWith('/psp/')) {
			let raw = '';
			for await (const c of req) raw += c;
			await pspProxy(req, res, raw);
		} else if (config.panel && req.method === 'POST' && req.url.startsWith('/painel/disparar/')) {
			const key = req.url.split('/')[3];
			if (!METHOD_SCENARIOS[key]) return res.writeHead(404).end();
			const out = await launchMethod(config, key, ip(req));
			res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
		} else if (config.panel && req.url.startsWith('/painel/chamadas')) {
			const order = new URL(req.url, 'http://x').searchParams.get('order');
			const recent = (await panelData(config)).orders;
			const mine = callsOf(order, recent);
			res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(mine));
		} else if (req.method === 'POST' && req.url === '/comprar') {
			let raw = '';
			for await (const c of req) raw += c;
			form = Object.fromEntries(new URLSearchParams(raw));
			const order = readOrder(form);
			if (order.errors.length) return html(res, 422, checkoutPage(config, form, order.errors));
			const id = await createIntent(config, order, ip(req));
			res.writeHead(303, { Location: `${config.checkoutUrl}/${id}` }).end();
		} else if (config.pspMockUrl && req.url.startsWith('/cenario/')) {
			const sc = SCENARIOS[req.url.split('/')[2]];
			if (!sc) return html(res, 404, checkoutPage(config, {}, ['Cenário inexistente.']));
			if (sc.mode) {
				await fetch(`${config.pspMockUrl}/__mode`, { method: 'POST', body: JSON.stringify({ psp: 'cielo', mode: sc.mode }) });
				console.log(`cenario: mock cielo = ${sc.mode}`);
			}
			const id = await createIntent(config, readOrder({ ...SAMPLE, qty_cafe: 1, qty_caneca: 0, qty_coador: 0, ...sc.cart }), ip(req), sc.currency, sc.currency === 'COP' ? { bankSlipProvider: 'Efecty' } : undefined);
			res.writeHead(303, { Location: `${config.checkoutUrl}/${id}` }).end();
		} else if (config.panel && req.url === '/painel') {
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(await readFile(join(dirname(fileURLToPath(import.meta.url)), 'painel.html')));
		} else if (config.panel && req.url === '/painel/dados') {
			res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(await panelData(config)));
		} else if (req.url === '/obrigado') {
			html(res, 200, page('Pedido recebido · Torra & Cia', '<h1>Obrigado!</h1><p>Recebemos seu pedido.</p><a href="/">Voltar à loja</a>'));
		} else {
			html(res, 200, checkoutPage(config));
		}
	} catch (e) {
		console.error(e.message);
		html(res, 502, checkoutPage(config, form, [`Não foi possível iniciar o pagamento: ${e.message}`]));
	}
	});
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
	const config = readConfig();
	createStoreServer(config).listen(config.port, () => console.log(`demo store on :${config.port}`));
}
