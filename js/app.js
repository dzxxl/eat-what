/* ==========================================================
   食材管家 · 主程序
   数据全部保存在浏览器 localStorage（键名 fridgeMate.v1），
   可在「设置」页导出 / 导入 JSON 备份。
   ========================================================== */

const STORE_KEY = 'fridgeMate.v1';
const APP_VERSION = '1.5.0';

/* ---------------- 状态与存储 ---------------- */

let state = loadState();
let currentTab = 'recommend';
let modalRecipeId = null;          // 当前打开的菜谱弹窗
let zoneModal = null;              // 当前打开的"分区食材"弹窗 {deviceId, zoneId}
let zoneModalVisible = false;      // 分区弹窗本身是否在屏幕上（false = 上面叠着子表单）
let fridgeModalOpen = false;       // "我的冰箱"弹窗处于打开流程中
let fridgeModalVisible = false;    // 屏幕上当前显示的就是它

// 列表页的筛选状态
let pantrySearch = '', pantryDevice = 'all', pantryZone = 'all', pantryCat = 'all';
let recipeSearch = '', recipeTag = 'all';
let recFilter = 'all';

function defaultState(){
  return {
    devices: [
      { id: uid(), name: '冰箱', zones: [{ id: uid(), name: '冷藏室', children: [] }, { id: uid(), name: '冷冻室', children: [] }] },
      { id: uid(), name: '冰柜', zones: [{ id: uid(), name: '冷冻室', children: [] }] }
    ],
    ingredients: [],
    customRecipes: [],
    favorites: [],
    todayMenu: [],
    settings: { servings: 2, lastAdjusted: 'servings', composeMode: 'smart', vegMeatConsiderStock: true, dishCount: null, aiApiKey: '', aiModel: 'glm-4.7-flash' },
    welcomed: false
  };
}

function loadState(){
  let raw = null;
  try { raw = localStorage.getItem(STORE_KEY); } catch(e){}
  if(!raw) return defaultState();
  try { return migrate(JSON.parse(raw)); }
  catch(e){ return defaultState(); }
}

/* 兼容旧数据 / 补齐缺失字段 */
function migrate(obj){
  const d = defaultState();
  const s = obj || {};
  return {
    devices: Array.isArray(s.devices) ? s.devices : d.devices,
    ingredients: Array.isArray(s.ingredients) ? s.ingredients : [],
    customRecipes: Array.isArray(s.customRecipes) ? s.customRecipes : [],
    favorites: Array.isArray(s.favorites) ? s.favorites : [],
    todayMenu: Array.isArray(s.todayMenu) ? s.todayMenu : [],
    settings: Object.assign({}, d.settings, s.settings || {}),
    welcomed: !!s.welcomed
  };
}

function save(){
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch(e){ toast('⚠️ 保存失败：浏览器存储不可用'); }
}

function uid(){
  return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function deviceById(id){ return state.devices.find(d => d.id === id) || null; }

/* 在设备里找分区：zoneId 可能指向"室"（冷藏室/冷冻室）或其下的"分层"（第一层…） */
function findZoneInDevice(dev, zoneId){
  for(const z of (dev.zones || [])){
    if(z.id === zoneId) return { room: z, zone: z, isRoom: true };
    for(const c of (z.children || [])){
      if(c.id === zoneId) return { room: z, zone: c, isRoom: false };
    }
  }
  return null;
}

function locText(item){
  if(!item.deviceId) return '未指定位置';
  const dev = deviceById(item.deviceId);
  if(!dev) return '未指定位置';
  const f = findZoneInDevice(dev, item.zoneId);
  if(!f) return dev.name;
  return f.isRoom ? `${dev.name}·${f.zone.name}` : `${dev.name}·${f.room.name}·${f.zone.name}`;
}

function ALL_RECIPES(){
  return RECIPES.concat(state.customRecipes || []);
}

function recipeById(id){
  return ALL_RECIPES().find(r => r.id === id) || null;
}

function buildCtx(){
  return { favorites: new Set(state.favorites || []), seasoningsMatter: !!state.settings.seasoningsMatter };
}

/* ---------------- 通用 UI ---------------- */

function toast(msg){
  const root = document.getElementById('toastRoot');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

function openModal(html, extraClass = ''){
  const root = document.getElementById('modalRoot');
  root.innerHTML = `<div class="overlay"><div class="modal ${extraClass}">${html}</div></div>`;
  const overlay = root.querySelector('.overlay');
  overlay.addEventListener('click', e => { if(e.target === overlay) closeModal(); });
  zoneModalVisible = false;
  fridgeModalVisible = false;
}

function closeModal(){
  document.getElementById('modalRoot').innerHTML = '';
  modalRecipeId = null;
  if(zoneModal){
    if(zoneModalVisible){
      // 用户主动关闭分区弹窗（点✕或点空白处）→ 真正关闭
      zoneModal = null;
      zoneModalVisible = false;
    } else {
      // 关闭的是分区弹窗上打开的子表单/确认框 → 回到分区弹窗
      openZoneItemsModal(zoneModal.deviceId, zoneModal.zoneId);
      return;
    }
  }
  if(fridgeModalOpen){
    if(fridgeModalVisible){
      fridgeModalOpen = false;
      fridgeModalVisible = false;
    } else {
      openFridgeModal(); // 关闭的是冰箱弹窗上的子表单 → 回到冰箱弹窗
    }
  }
}

function confirmModal({ title, html, okText = '确定', danger = false }){
  return new Promise(resolve => {
    openModal(`
      <div class="modal-head"><h2>${esc(title)}</h2><button class="close-x" data-action="confirm-close">✕</button></div>
      <div class="modal-body">${html || ''}</div>
      <div class="modal-foot">
        <button class="btn" data-action="confirm-close">取消</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="confirmOk">${esc(okText)}</button>
      </div>`);
    document.getElementById('confirmOk').addEventListener('click', () => { closeModal(); resolve(true); });
    document.querySelectorAll('[data-action="confirm-close"]').forEach(b =>
      b.addEventListener('click', () => { closeModal(); resolve(false); }));
  });
}

function esc(s){
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));
}

function expiryBadge(it){
  if(!it.expiry) return '';
  const d = daysUntil(it.expiry);
  if(d === null) return '';
  let cls = 'b-gray', txt = `${it.expiry.slice(5).replace('-','/')} 到期`;
  if(d < 0){ cls = 'b-red'; txt = '已过期'; }
  else if(d <= 2){ cls = 'b-red'; txt = d === 0 ? '今天到期' : `${d}天后过期`; }
  else if(d <= 7){ cls = 'b-amber'; txt = `${d}天后到期`; }
  return `<span class="bexp ${cls}">${txt}</span>`;
}

/* ---------------- 主渲染 ---------------- */

function renderAll(keepScroll){
  renderNav();
  // 菜谱页保持"搜索栏固定 + 列表内滚"；推荐页为整页滚动 + 筛选行吸顶
  document.body.classList.toggle('page-fixed-body', currentTab === 'recipes');
  const main = document.getElementById('main');
  if(currentTab === 'recommend') main.innerHTML = viewRecommend();
  else if(currentTab === 'pantry') main.innerHTML = viewPantry();
  else if(currentTab === 'fridge') main.innerHTML = viewFridge();
  else if(currentTab === 'recipes') main.innerHTML = viewRecipes();
  else main.innerHTML = viewSettings();
  refreshDatalists();
  if(!keepScroll) window.scrollTo(0, 0);
  syncTopbarHeight();
}

/* 把顶栏实际高度写入 CSS 变量，供筛选行吸顶时贴在顶栏下方 */
function syncTopbarHeight(){
  const tb = document.querySelector('.topbar');
  if(tb) document.documentElement.style.setProperty('--topbar-h', Math.round(tb.getBoundingClientRect().height) + 'px');
}
window.addEventListener('resize', syncTopbarHeight);

function renderNav(){
  document.querySelectorAll('.tabbtn[data-tab]').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === currentTab);
  });
}

function switchTab(tab){
  if(zoneModal){ zoneModal = null; zoneModalVisible = false; }
  fridgeModalOpen = false; fridgeModalVisible = false;
  closeModal();
  currentTab = tab;
  renderAll();
}

/* ---------------- 推荐页 ---------------- */

function viewRecommend(){
  const servings = state.settings.servings || 2;
  const mode = state.settings.composeMode || 'smart';
  const modeLabel = { smart:'智能配餐', random:'随机配餐', veg:'今日吃素', meat:'今日吃肉' }[mode] || '智能配餐';
  const modeEmoji = { smart:'✨', random:'🎲', veg:'🥬', meat:'🍖' }[mode] || '✨';
  const considerStock = state.settings.vegMeatConsiderStock !== false;
  const pantry = buildPantry(state.ingredients);
  const ctx = buildCtx();
  const entries = rankRecipes(pantry, servings, ctx);

  const readyCount = entries.filter(e => e.a.enough).length;
  const almostCount = entries.filter(e => !e.a.enough && e.a.coverage > 0 && gapCount(e.a) <= 2).length;
  const favCount = entries.filter(e => ctx.favorites.has(e.recipe.id)).length;

  let filtered = entries;
  if(recFilter === 'ready') filtered = entries.filter(e => e.a.enough);
  else if(recFilter === 'almost') filtered = entries.filter(e => !e.a.enough && e.a.coverage > 0 && gapCount(e.a) <= 2);
  else if(recFilter === 'fav') filtered = entries.filter(e => ctx.favorites.has(e.recipe.id));

  const hasStock = state.ingredients.length > 0;

  let menuHtml = '';
  const menu = state.todayMenu || [];
  if(menu.length){
    const menuEntries = menu.map(m => {
      const r = recipeById(m.id);
      return r ? { id: m.id, locked: !!m.locked, recipe: r, a: analyzeRecipe(r, pantry, servings, ctx) } : null;
    }).filter(Boolean);
    const lockedCount = menuEntries.filter(d => d.locked).length;
    const gaps = menuGaps(menuEntries);
    const gapStr = gaps.length
      ? gaps.map(g => g.type === '缺' ? `缺 ${esc(g.label)}` : `${esc(g.label)}量不够`).join('、')
      : '太棒了，这个搭配的食材全都有！🎉';
    menuHtml = `
      <div class="menu-panel">
        <h3>🍽️ 今日菜单（${menuEntries.length} 道${lockedCount ? ' · 🔒 ' + lockedCount + ' 道已锁定' : ''}）</h3>
        <div class="menu-sub">模式：${modeLabel} · 按 ${servings} 人份 · 点 🔒 锁定后换搭配不变 · 点 ✕ 移除</div>
        ${menuEntries.map(d => `
          <div class="menu-dish${d.locked ? ' locked' : ''}">
            <button class="iconbtn lock-btn ${d.locked ? 'locked' : ''}" data-action="menu-lock" data-id="${d.id}" title="${d.locked ? '已锁定：换搭配时保持不变' : '未锁定：换搭配时会更新'}">${d.locked ? '🔒' : '🔓'}</button>
            <span class="md-name" data-action="open-recipe" data-id="${d.id}">${esc(d.recipe.name)}</span>
            <span class="md-ctrl">
              <span class="md-right">${dishCovChip(d.a)}</span>
              <button class="iconbtn" data-action="remove-menu" data-id="${d.id}" title="从菜单移除">✕</button>
            </span>
          </div>`).join('')}
        <div class="menu-gaps">🛒 还需准备：${gapStr}</div>
        <div class="menu-actions">
          <button class="btn btn-sm" data-action="compose-menu">🔄 换一套搭配</button>
          <button class="btn btn-sm" data-action="clear-menu">🗑 清空菜单</button>
        </div>
      </div>`;
  }

  return `
    <div class="card controls-card">
      <div class="rc-title-row">
        <div>
          <h1 class="rc-title">🍳 今日吃啥</h1>
          <p class="rc-sub">按冰箱里的存货排序 · 点菜名看做法</p>
        </div>
        <div class="item-actions">
          <button class="btn btn-sm" data-action="switch-mode" title="选择配餐模式">🔀 切换模式</button>
        </div>
        <button class="btn btn-primary" data-action="compose-menu">${modeEmoji} ${modeLabel}</button>
      </div>
      <div class="rc-serv-row">
        <span style="font-weight:700; font-size:14px;">就餐人数</span>
        <span class="stepper">
          <button data-action="servings" data-delta="-1">−</button>
          <span class="stepper-val">${servings} 人</span>
          <button data-action="servings" data-delta="1">＋</button>
        </span>
        <span style="font-weight:700; font-size:14px; margin-left:18px;">菜品数量</span>
        <span class="stepper">
          <button data-action="dish-count" data-delta="-1">−</button>
          <span class="stepper-val">${getEffectiveDishCount()} 道</span>
          <button data-action="dish-count" data-delta="1">＋</button>
        </span>
        ${(mode === 'veg' || mode === 'meat') ? `<span class="chip clickable ${considerStock ? 'chip-green' : ''}" data-action="toggle-consider-stock" title="${considerStock ? '开启中：优先搭配你现有食材能做的菜' : '关闭中：不看库存随机选'}">${considerStock ? '🥕 考虑已有食材 ✓' : '🎲 不考虑已有食材'}</span>` : ''}
      </div>
      ${hasStock ? '' : `<div class="hint" style="margin-top:10px;">还没有记录食材，先去 <a href="#" data-action="tab" data-tab="pantry" style="color:var(--pri-deep); font-weight:700;">🥕 食材页</a> 把家里现有的加进来，推荐才准哦。</div>`}
    </div>

    ${menuHtml}

    <div class="chips sticky-chips">
      <span class="chip clickable ${recFilter === 'all' ? 'active' : ''}" data-action="rec-filter" data-f="all">全部 ${entries.length}</span>
      <span class="chip clickable chip-green ${recFilter === 'ready' ? 'active' : ''}" data-action="rec-filter" data-f="ready">✓ 能马上做 ${readyCount}</span>
      <span class="chip clickable chip-amber ${recFilter === 'almost' ? 'active' : ''}" data-action="rec-filter" data-f="almost">差一点 ${almostCount}</span>
      <span class="chip clickable ${recFilter === 'fav' ? 'active' : ''}" data-action="rec-filter" data-f="fav">★ 收藏 ${favCount}</span>
    </div>

    <div class="grid">
      ${filtered.length
        ? filtered.map(recipeCard).join('')
        : `<div class="empty" style="grid-column:1/-1;"><span class="empty-emoji">🥘</span><b>这个筛选下没有菜</b><p>换个筛选条件，或者补充点食材～</p></div>`}
    </div>`;
}

function gapCount(a){ return a.missing.length + a.short.length; }

function dishCovChip(a){
  if(a.enough) return `<span class="chip chip-green">✓ 食材全有</span>`;
  const pct = Math.round(a.coverage * 100);
  return `<span class="chip chip-amber">${pct}% 匹配</span>`;
}

function recipeCard(entry){
  const { recipe: r, a } = entry;
  const pct = Math.round(a.coverage * 100);
  const cls = a.enough ? 'full' : (pct >= 60 ? 'mid' : 'low');
  const fav = (state.favorites || []).includes(r.id) ? '★' : '';
  const inMenu = (state.todayMenu || []).some(m => m.id === r.id);
  const haveChips = a.have.slice(0, 8).map(x => `<span class="chip chip-green">${esc(x.ing.name)}</span>`).join('')
    + (a.have.length > 8 ? `<span class="chip chip-gray">+${a.have.length - 8}</span>` : '');
  const missChips = a.missing.map(m => `<span class="chip chip-red">${m.src === 'seasoning' ? '🧂' : ''}缺 ${esc(m.name)}</span>`).join('');
  const shortChips = a.short.map(s =>
    `<span class="chip chip-amber" title="需${fmtQty(s.need)}${esc(s.ing.unit || '')}，现有${fmtQty(s.have)}${esc(s.ing.unit || '')}${s.userLabel && s.userLabel !== s.ing.name ? '（你的库存：' + esc(s.userLabel) + '）' : ''}">${esc(s.ing.name)}不太够</span>`).join('');
  return `
    <div class="recipe-card" data-action="open-recipe" data-id="${r.id}">
      <div class="r-top">
        <span class="r-name">${fav} ${esc(r.name)}</span>
        <span class="cov-mini">
          <span class="cov-bar"><span class="cov-fill ${cls}" style="width:${pct}%"></span></span>
          <span class="cov-num">${a.enough ? '能做' : pct + '%'}</span>
        </span>
      </div>
      <div class="r-chips">${(r.tags || []).map(t => `<span class="chip">${esc(t)}</span>`).join('')}<span class="chip chip-gray">⏱ ${r.time || '?'}分钟</span>${a.expiring ? '<span class="chip chip-amber">⏰ 用到快过期食材</span>' : ''}<span class="chip clickable ${inMenu ? 'chip-green' : ''}" data-action="toggle-menu" data-id="${r.id}" title="加入/移出今日菜单">${inMenu ? '✓ 今日菜单' : '＋ 今日菜单'}</span></div>
      <div class="r-ings">
        ${haveChips ? `<div class="r-ing-row"><span class="r-lab ok">✓ 有</span><span class="r-ing-chips">${haveChips}</span></div>` : ''}
        ${missChips ? `<div class="r-ing-row"><span class="r-lab no">✗ 缺</span><span class="r-ing-chips">${missChips}</span></div>` : ''}
        ${shortChips ? `<div class="r-ing-row"><span class="r-lab mid">△ 量不足</span><span class="r-ing-chips">${shortChips}</span></div>` : ''}
      </div>
    </div>`;
}

/* ---------------- 菜谱详情弹窗 ---------------- */

function renderRecipeModal(id){
  const r = recipeById(id);
  if(!r) return;
  const servings = state.settings.servings || 2;
  const pantry = buildPantry(state.ingredients);
  const a = analyzeRecipe(r, pantry, servings, buildCtx());
  const fav = (state.favorites || []).includes(r.id);
  const inMenu = (state.todayMenu || []).some(m => m.id === r.id);
  const seasoningsMatter = !!state.settings.seasoningsMatter;

  // 开启"调料参与匹配"后，调料也逐个显示有无
  const seasonRows = seasoningsMatter ? (r.seasonings || []).map(s => {
    const p = pantry[normalizeName(s)];
    if(p){
      const locs = [...new Set(p.items.map(it => locText(it)))].join('、');
      return `<div class="ing-status"><span class="st st-have">✓</span><div class="is-main"><span class="is-name">🧂 ${esc(s)}</span><div class="is-loc">📍 ${esc(locs)}</div></div></div>`;
    }
    return `<div class="ing-status"><span class="st st-dim">✗</span><div class="is-main"><span class="is-name">🧂 ${esc(s)}</span></div><span class="st st-miss">缺</span></div>`;
  }).join('') : '';

  const rows = (r.ingredients || []).map(ing => {
    const p = pantry[normalizeName(ing.name)];
    const need = (typeof ing.amount === 'number') ? `${fmtQty(scaledAmount(r, ing, servings))}${esc(ing.unit || '')}` : '适量';
    const opt = ing.optional ? ' <span class="hint">（可选）</span>' : '';
    if(!p){
      return `<div class="ing-status"><span class="st st-dim">✗</span>
        <div class="is-main"><span class="is-name${ing.optional ? ' opt' : ''}">${esc(ing.name)}</span>${opt}
        <span class="is-qty">${need}</span></div>
        <span class="st st-miss">${ing.optional ? '' : '缺'}</span></div>`;
    }
    const need2 = (typeof ing.amount === 'number') ? scaledAmount(r, ing, servings) : null;
    const unitOk = p.unit && ing.unit && p.unit === ing.unit;
    if(need2 !== null && p.qtyKnown && unitOk && p.totalQty < need2 - 0.001){
      return `<div class="ing-status"><span class="st st-short">△</span>
        <div class="is-main"><span class="is-name${ing.optional ? ' opt' : ''}">${esc(ing.name)}</span>${opt}
        <span class="is-qty">${need}</span>
        <div class="is-note" style="color:var(--amber);">现有 ${fmtQty(p.totalQty)}${esc(p.unit)}，量可能不够</div></div></div>`;
    }
    const locs = [...new Set(p.items.map(it => locText(it)))].join('、');
    return `<div class="ing-status"><span class="st st-have">✓</span>
      <div class="is-main"><span class="is-name${ing.optional ? ' opt' : ''}">${esc(ing.name)}</span>${opt}
      <span class="is-qty">${need}</span>
      <div class="is-loc">📍 ${esc(locs)}</div></div></div>`;
  }).join('');

  openModal(`
    <div class="modal-head">
      <h2>${esc(r.name)} <span class="hint">${(r.tags || []).map(t => '#' + esc(t)).join(' ')}</span></h2>
      <button class="close-x" data-action="close-modal">✕</button>
    </div>
    <div class="modal-body">
      <div class="hint">⏱ ${r.time || '?'} 分钟 · 难度 ${esc(r.difficulty || '简单')} · 菜谱基准 ${r.baseServings || 2} 人份</div>
      <div class="modal-serv">
        <b>做几人份</b>
        <span class="stepper">
          <button data-action="servings" data-delta="-1">−</button>
          <span class="stepper-val">${servings} 人</span>
          <button data-action="servings" data-delta="1">＋</button>
        </span>
      </div>
      <h3 style="font-size:15px; margin:14px 0 4px;">食材清单（已按 ${servings} 人份换算）</h3>
      ${rows}
      ${seasonRows}
      ${(r.seasonings || []).length ? `<div class="season-note">${seasoningsMatter ? '🧂 调料匹配已开启（设置里可切换），以上🧂调料已按普通食材对待：' : '🧂 需要调料（默认家里常备，不参与匹配）：'}${r.seasonings.map(esc).join('、')}</div>` : ''}
      <h3 style="font-size:15px; margin:16px 0 0;">做法步骤</h3>
      <ol class="steps">${(r.steps || []).map(s => `<li>${esc(s)}</li>`).join('')}</ol>
    </div>
    <div class="modal-foot">
      ${r.custom ? `<button class="btn" data-action="edit-recipe" data-id="${r.id}">✏️ 编辑</button>
                    <button class="btn btn-danger" data-action="del-recipe" data-id="${r.id}">🗑 删除</button>` : ''}
      <button class="btn" data-action="toggle-menu" data-id="${r.id}">${inMenu ? '✓ 在今日菜单' : '＋ 加入今日菜单'}</button>
      <button class="btn" data-action="fav-toggle" data-id="${r.id}">${fav ? '★ 已收藏' : '☆ 收藏'}</button>
      <button class="btn" data-action="copy-missing" data-id="${r.id}">📋 复制缺少的</button>
      <button class="btn btn-primary" data-action="deduct" data-id="${r.id}">✔ 做完了，扣减食材</button>
    </div>`);
  modalRecipeId = id;
}

/* ---------------- 食材页 ---------------- */

function viewPantry(){
  const items = state.ingredients;
  const expiringCount = items.filter(isExpiringSoon).length;

  return `
    <div class="page-head">
      <div><h1>🥕 我的食材</h1><p>记下家里有什么、有多少、放在哪</p></div>
      <div class="item-actions">
        <button class="btn" data-action="open-fridge-modal">🧊 我的冰箱</button>
        <button class="btn btn-primary" data-action="add-ingredient">＋ 添加食材</button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat-card"><b>${items.length}</b><span>食材种数</span></div>
      <div class="stat-card"><b style="color:${expiringCount ? 'var(--red)' : 'inherit'};">${expiringCount}</b><span>快过期</span></div>
      <div class="stat-card"><b>${state.devices.length}</b><span>存储设备</span></div>
    </div>

    <div class="card">
      <div class="search-row">
        <input type="search" placeholder="🔍 搜索食材名…" value="${esc(pantrySearch)}" data-input="pantry-search" style="flex:1; min-width:160px;">
        <select data-change="pantry-device" style="width:auto;">
          <option value="all">全部位置</option>
          ${state.devices.map(d => `<option value="${d.id}" ${pantryDevice === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
        </select>
        <button class="btn btn-sm" data-action="clear-pantry-filters" style="${pantrySearch.trim() || pantryDevice !== 'all' || pantryZone !== 'all' || pantryCat !== 'all' ? '' : 'display:none;'}">清除筛选</button>
      </div>
      <div class="scroll-chips" style="margin-top:10px;">
        <span class="chip clickable ${pantryCat === 'all' ? 'active' : ''}" data-action="pantry-cat" data-c="all">全部</span>
        ${CATEGORY_LIST.map(c => `<span class="chip clickable ${pantryCat === c ? 'active' : ''}" data-action="pantry-cat" data-c="${c}">${CATEGORY_EMOJI[c]} ${c}</span>`).join('')}
      </div>
    </div>

    <div id="pantry-results">${pantryResultsHtml()}</div>`;
}

/* 食材列表结果区（搜索时只刷新这一块，不打断输入） */
function pantryResultsHtml(){
  let list = state.ingredients;
  if(pantrySearch.trim()){
    const q = normalizeName(pantrySearch.trim());
    list = list.filter(it => normalizeName(it.name).includes(q) || (it.name || '').includes(pantrySearch.trim()));
  }
  if(pantryDevice !== 'all') list = list.filter(it => it.deviceId === pantryDevice);
  if(pantryZone !== 'all') list = list.filter(it => it.zoneId === pantryZone);
  if(pantryCat !== 'all') list = list.filter(it => (it.category || '其他') === pantryCat);

  // 分组：设备 → 室（冷藏室/冷冻室）→ 分层
  const buckets = [];
  for(const dev of state.devices){
    const devItems = list.filter(it => it.deviceId === dev.id);
    if(!devItems.length) continue;
    const zones = [];
    for(const room of (dev.zones || [])){
      const direct = devItems.filter(it => it.zoneId === room.id);
      const kids = room.children || [];
      if(direct.length || kids.some(c => devItems.some(it => it.zoneId === c.id))){
        zones.push({ name: room.name, level: 0, items: direct });
        for(const c of kids){
          const cItems = devItems.filter(it => it.zoneId === c.id);
          if(cItems.length) zones.push({ name: c.name, level: 1, items: cItems });
        }
      }
    }
    const noZone = devItems.filter(it => !it.zoneId || !findZoneInDevice(dev, it.zoneId));
    if(noZone.length) zones.push({ name: '未分区', level: 0, items: noZone });
    buckets.push({ name: '❄️ ' + dev.name, items: devItems, zones });
  }
  const loose = list.filter(it => !it.deviceId || !deviceById(it.deviceId));
  if(loose.length) buckets.push({ name: '📦 未指定位置', items: loose, zones: [{ name: '', level: 0, items: loose }] });

  const hasFilter = pantrySearch.trim() || pantryDevice !== 'all' || pantryZone !== 'all' || pantryCat !== 'all';

  return list.length ? buckets.map(b => `
      <div class="group-head"><h3>${esc(b.name)}</h3><span class="g-count">${b.items.length} 种</span></div>
      ${b.zones.map(z => `
        ${z.name ? `<div class="zone-head ${z.level ? 'sub' : ''}">${z.level ? esc(z.name) : '🗄 ' + esc(z.name)}</div>` : ''}
        <div class="ing-list">
          ${z.items.map(ingRow).join('')}
        </div>`).join('')}
    `).join('') : `
      <div class="empty">
        <span class="empty-emoji">${hasFilter ? '🔍' : '🧺'}</span>
        <b>${hasFilter ? '没有符合条件的食材' : '还没有记录食材'}</b>
        <p>${hasFilter ? '试试放宽筛选条件' : '点右上角「＋ 添加食材」，把冰箱里的东西记进来吧'}</p>
        ${hasFilter ? '' : '<button class="btn btn-primary" data-action="add-ingredient">＋ 添加第一样食材</button>'}
      </div>`;
}

function ingRow(it){
  const emoji = CATEGORY_EMOJI[it.category] || '📦';
  const qtyStr = (typeof it.qty === 'number') ? `${fmtQty(it.qty)}${it.unit || ''}` : '有(未记量)';
  return `
    <div class="ing-row">
      <span class="ing-emoji">${emoji}</span>
      <div class="ing-main">
        <div class="ing-name">${esc(it.name)} ${expiryBadge(it)}</div>
        <div class="ing-sub">📍 ${esc(locText(it))}${it.note ? ' · ' + esc(it.note) : ''}</div>
      </div>
      <span class="qty-pill" data-action="qty-edit" data-id="${it.id}" title="点击修改数量/单位">${qtyStr}</span>
      <div class="item-actions">
        <button class="iconbtn" data-action="qty-adj" data-id="${it.id}" data-delta="-1" title="减少">−</button>
        <button class="iconbtn" data-action="qty-adj" data-id="${it.id}" data-delta="1" title="增加">＋</button>
        <button class="iconbtn" data-action="edit-ingredient" data-id="${it.id}" title="编辑">✏️</button>
        <button class="iconbtn danger" data-action="del-ingredient" data-id="${it.id}" title="删除">🗑</button>
      </div>
    </div>`;
}

/* 点击数量：弹出小窗口，数量和单位一起改 */
function openQtyModal(id){
  const it = state.ingredients.find(x => x.id === id);
  if(!it) return;
  openModal(`
    <div class="modal-head"><h2>✏️ 改数量</h2><button class="close-x" data-action="close-modal">✕</button></div>
    <div class="modal-body">
      <div class="qtym-name">${CATEGORY_EMOJI[it.category] || '📦'} ${esc(it.name)} <span class="hint">· 📍 ${esc(locText(it))}</span></div>
      <form data-form="qty" data-id="${it.id}" id="qtyForm">
        <div class="form-grid">
          <div class="field"><label>数量（留空 = 未记量）</label><input name="qty" type="number" step="any" min="0" value="${typeof it.qty === 'number' ? it.qty : ''}" placeholder="如：6"></div>
          <div class="field"><label>单位</label><input name="unit" data-suggest="unit" autocomplete="off" value="${esc(it.unit || '')}" placeholder="个 / 克 / 根…"></div>
        </div>
      </form>
    </div>
    <div class="modal-foot">
      <button class="btn" data-action="close-modal">取消</button>
      <button class="btn btn-primary" data-action="submit-qty" data-id="${it.id}">保存</button>
    </div>`);
}

function submitQty(id){
  const it = state.ingredients.find(x => x.id === id);
  const form = document.getElementById('qtyForm');
  if(!it || !form) return;
  const qtyRaw = form.querySelector('[name=qty]').value.trim();
  if(qtyRaw === ''){
    it.qty = null;
  } else {
    const n = Number(qtyRaw);
    if(!isFinite(n) || n < 0){ toast('数量格式不对'); return; }
    it.qty = roundQty(n);
  }
  it.unit = form.querySelector('[name=unit]').value.trim();
  save();
  closeModal();
  renderAll();
  toast('✅ 数量已更新');
}

/* 添加 / 编辑食材弹窗（pre: {deviceId, zoneId} 从分区弹窗进入时预选位置） */
function openIngredientForm(id, pre){
  pre = pre || null;
  const it = id ? state.ingredients.find(x => x.id === id) : null;
  const devId = it ? it.deviceId || ''
    : pre ? pre.deviceId
    : (pantryDevice !== 'all' ? pantryDevice : '');
  const preZone = it ? it.zoneId || '' : (pre ? pre.zoneId : '');
  openModal(`
    <div class="modal-head"><h2>${it ? '编辑食材' : '添加食材'}</h2><button class="close-x" data-action="close-modal">✕</button></div>
    <div class="modal-body">
      <form data-form="ingredient" id="ingredientForm">
        <input type="hidden" name="id" value="${it ? it.id : ''}">
        <div class="form-grid">
          <div class="field"><label>食材名称 *</label><input name="name" data-suggest="ingredient" autocomplete="off" required value="${it ? esc(it.name) : ''}" placeholder="如：鸡蛋"></div>
          <div class="field"><label>分类</label>
            <select name="category">
              <option value="">自动识别</option>
              ${CATEGORY_LIST.map(c => `<option value="${c}" ${it && it.category === c ? 'selected' : ''}>${CATEGORY_EMOJI[c]} ${c}</option>`).join('')}
            </select></div>
          <div class="field"><label>数量（可不填）</label><input name="qty" type="number" step="any" min="0" value="${it && typeof it.qty === 'number' ? it.qty : ''}" placeholder="有但不知道量可留空"></div>
          <div class="field"><label>单位</label><input name="unit" data-suggest="unit" autocomplete="off" value="${it ? esc(it.unit || '') : ''}" placeholder="个 / 克 / 根…"></div>
          <div class="field"><label>放在哪（设备）</label>
            <select name="deviceId" data-change="form-device">
              <option value="">未指定位置</option>
              ${state.devices.map(d => `<option value="${d.id}" ${devId === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
            </select></div>
          <div class="field"><label>放在哪（分区）</label>
            <select name="zoneId" id="zoneSelect"></select></div>
          <div class="field"><label>保质期 / 最佳食用期</label><input name="expiry" type="date" value="${it ? it.expiry || '' : ''}"></div>
          <div class="field"><label>备注</label><input name="note" value="${it ? esc(it.note || '') : ''}" placeholder="如：已开封"></div>
        </div>
      </form>
    </div>
    <div class="modal-foot">
      <button class="btn" data-action="close-modal">取消</button>
      <button class="btn btn-primary" data-action="submit-ingredient">${it ? '保存修改' : '添加'}</button>
    </div>`);
  fillZoneSelect(document.getElementById('ingredientForm'), devId, preZone);
}

function fillZoneSelect(form, deviceId, selected){
  const sel = form.querySelector('#zoneSelect') || form.querySelector('[name=zoneId]');
  if(!sel) return;
  const dev = deviceById(deviceId);
  let html = `<option value="">未分区</option>`;
  if(dev){
    for(const room of (dev.zones || [])){
      const kids = room.children || [];
      if(kids.length){
        html += `<optgroup label="${esc(room.name)}">`;
        html += `<option value="${room.id}" ${selected === room.id ? 'selected' : ''}>${esc(room.name)}（不细分）</option>`;
        for(const c of kids) html += `<option value="${c.id}" ${selected === c.id ? 'selected' : ''}>${esc(c.name)}</option>`;
        html += `</optgroup>`;
      } else {
        html += `<option value="${room.id}" ${selected === room.id ? 'selected' : ''}>${esc(room.name)}</option>`;
      }
    }
  }
  sel.innerHTML = html;
}

/* ---------------- 冰箱分区页（两级：室 → 分层） ---------------- */

function viewFridge(){
  if(!state.devices.length){
    return `
      <div class="page-head"><div><h1>🧊 冰箱与冰柜</h1><p>先把家里的冰箱、冰柜建好，加食材时才能选位置</p></div></div>
      <div class="empty"><span class="empty-emoji">🧊</span><b>还没有存储设备</b><p>添加你的冰箱或冰柜，先分"冷藏室 / 冷冻室"，再往下分"第一层、第二层"</p>
      <button class="btn btn-primary" data-action="add-device">＋ 添加冰箱 / 冰柜</button></div>`;
  }
  return `
    <div class="page-head">
      <div><h1>🧊 冰箱与冰柜</h1><p>先分"冷藏室 / 冷冻室"，可在其下再分层；按住行首 ⠿ 长按拖动排序</p></div>
      <button class="btn btn-primary" data-action="add-device">＋ 添加冰箱 / 冰柜</button>
    </div>
    ${state.devices.map(dev => {
      const count = state.ingredients.filter(it => it.deviceId === dev.id).length;
      const roomRow = (room) => {
        const direct = state.ingredients.filter(it => it.deviceId === dev.id && it.zoneId === room.id).length;
        const kids = room.children || [];
        const kidCount = kids.reduce((s, c) => s + state.ingredients.filter(it => it.zoneId === c.id).length, 0);
        return `
        <div class="zone-block" data-room-id="${room.id}">
          <div class="zone-row" data-id="${room.id}" data-kind="room" data-device="${dev.id}">
            <span class="drag-handle" title="长按拖动排序">⠿</span>
            <span class="z-name">🧊 ${esc(room.name)}</span>
            <span class="hint">${direct + kidCount} 种</span>
            <button class="btn btn-sm" data-action="view-zone" data-device="${dev.id}" data-zone="${room.id}">👀 查看</button>
            <button class="iconbtn" data-action="edit-zone" data-device="${dev.id}" data-id="${room.id}">✏️</button>
            <button class="iconbtn danger" data-action="del-zone" data-device="${dev.id}" data-id="${room.id}">🗑</button>
          </div>
          ${kids.map(c => {
            const cc = state.ingredients.filter(it => it.zoneId === c.id).length;
            return `
            <div class="zone-row zone-sub" data-id="${c.id}" data-kind="child" data-device="${dev.id}" data-room="${room.id}">
              <span class="drag-handle" title="长按拖动排序">⠿</span>
              <span class="z-name">${esc(c.name)}</span>
              <span class="hint">${cc} 种</span>
              <button class="btn btn-sm" data-action="view-zone" data-device="${dev.id}" data-zone="${c.id}">👀 查看</button>
              <button class="iconbtn" data-action="edit-zone" data-device="${dev.id}" data-id="${c.id}">✏️</button>
              <button class="iconbtn danger" data-action="del-zone" data-device="${dev.id}" data-id="${c.id}">🗑</button>
            </div>`;
          }).join('')}
          <button class="zone-add-layer" data-action="add-layer" data-device="${dev.id}" data-room="${room.id}">＋ 添加分层（第一层、第二层…）</button>
        </div>`;
      };
      return `
      <div class="card device-card">
        <div class="dev-head">
          <span class="dev-title" data-action="device-menu" data-id="${dev.id}" title="点击管理：添加分区 / 改名 / 删除">❄️ ${esc(dev.name)} <span class="hint">（${count} 种食材 · 点击管理）</span></span>
        </div>
        ${(dev.zones || []).map(roomRow).join('')}
      </div>`;
    }).join('')}`;
}

/* ---------- 长按拖动排序（室与分层通用） ---------- */

let zoneDrag = null;

document.addEventListener('pointerdown', e => {
  const handle = e.target.closest && e.target.closest('.drag-handle');
  if(!handle) return;
  const row = handle.closest('[data-id][data-kind]');
  if(!row) return;
  e.preventDefault();
  zoneDrag = { row, startX: e.clientX, startY: e.clientY, timer: setTimeout(() => startZoneDrag(row), 280), started: false };
});
document.addEventListener('pointermove', e => {
  if(!zoneDrag) return;
  if(!zoneDrag.started){
    if(Math.hypot(e.clientX - zoneDrag.startX, e.clientY - zoneDrag.startY) > 8){
      clearTimeout(zoneDrag.timer); // 只是普通滚动/点按，取消长按
      zoneDrag = null;
    }
    return;
  }
  e.preventDefault();
  moveZoneRow(e.clientY);
});
document.addEventListener('pointerup', endZoneDrag);
document.addEventListener('pointercancel', endZoneDrag);

function startZoneDrag(row){
  zoneDrag.started = true;
  zoneDrag.wrapper = row.dataset.kind === 'room' ? row.closest('.zone-block') : row;
  zoneDrag.container = zoneDrag.wrapper.parentElement;
  zoneDrag.wrapper.classList.add('dragging');
  document.body.classList.add('zone-dragging');
}

function moveZoneRow(clientY){
  const container = zoneDrag.container, w = zoneDrag.wrapper;
  const siblings = [...container.children].filter(el => el !== w && (w.classList.contains('zone-block') ? el.classList.contains('zone-block') : el.classList.contains('zone-sub')));
  const next = siblings.find(el => {
    const r = el.getBoundingClientRect();
    return clientY < r.top + r.height / 2;
  });
  if(next) container.insertBefore(w, next);
  else if(siblings.length) container.insertBefore(w, siblings[siblings.length - 1].nextSibling);
}

function endZoneDrag(){
  if(!zoneDrag) return;
  clearTimeout(zoneDrag.timer);
  document.body.classList.remove('zone-dragging');
  const st = zoneDrag;
  zoneDrag = null;
  if(!st.started) return;
  const { wrapper, container, row } = st;
  if(!wrapper || !container){ renderAll(); return; } // 拖动状态异常时直接还原，不写数据
  wrapper.classList.remove('dragging');
  const dev = deviceById(row.dataset.device);
  if(!dev){ renderAll(); return; }
  const ids = [...container.children]
    .filter(el => el.classList.contains(row.dataset.kind === 'room' ? 'zone-block' : 'zone-sub'))
    .map(el => el.dataset.id);
  if(!ids.length){ renderAll(); return; }
  if(row.dataset.kind === 'room'){
    const newList = ids.map(i => dev.zones.find(z => z.id === i)).filter(Boolean);
    // 数量对不上说明解析异常，宁可不保存也不能清空数据
    if(newList.length === dev.zones.length) dev.zones = newList;
  } else {
    const f = findZoneInDevice(dev, row.dataset.id);
    if(f && !f.isRoom){
      const list = f.room.children || [];
      const newList = ids.map(i => list.find(c => c.id === i)).filter(Boolean);
      if(newList.length === list.length) f.room.children = newList;
    }
  }
  save();
  renderAll();
}

/* "我的冰箱"弹窗：在食材页直接查看/管理冰箱结构 */
function openFridgeModal(){
  fridgeModalOpen = true;
  openModal(`
    <div class="modal-head"><h2>🧊 我的冰箱</h2><button class="close-x" data-action="close-fridge-modal">✕</button></div>
    <div class="modal-body modal-wide">${viewFridge()}</div>`, 'modal-wide');
  fridgeModalVisible = true;
}

/* 点冰箱名称：弹出管理菜单（添加分区 / 改名 / 删除） */
function openDeviceMenu(id){
  const dev = deviceById(id);
  if(!dev) return;
  openModal(`
    <div class="modal-head"><h2>❄️ ${esc(dev.name)}</h2><button class="close-x" data-action="close-modal">✕</button></div>
    <div class="modal-body">
      <button class="btn btn-block menu-btn" data-action="add-device-zone" data-id="${dev.id}">＋ 添加分区（冷藏室 / 冷冻室…）</button>
      <button class="btn btn-block menu-btn" data-action="edit-device" data-id="${dev.id}">✏️ 改名</button>
      <button class="btn btn-block menu-btn btn-danger" data-action="del-device" data-id="${dev.id}">🗑 删除这台设备</button>
    </div>`);
}

/* 在管理菜单里添加分区（室） */
function openZoneAddForm(deviceId){
  const dev = deviceById(deviceId);
  if(!dev) return;
  openModal(`
    <div class="modal-head"><h2>＋ 添加分区（${esc(dev.name)}）</h2><button class="close-x" data-action="close-modal">✕</button></div>
    <div class="modal-body">
      <form data-form="zone-add" data-device="${dev.id}">
        <div class="field"><label>分区名称 *</label><input name="zn" required placeholder="如：冷藏室、冷冻室、变温室…"></div>
      </form>
    </div>
    <div class="modal-foot">
      <button class="btn" data-action="close-modal">取消</button>
      <button class="btn btn-primary" data-action="submit-zone-add" data-device="${dev.id}">添加</button>
    </div>`);
}

function submitZoneAddFromForm(form){
  if(!form) return;
  const dev = deviceById(form.dataset.device);
  const name = form.querySelector('[name=zn]').value.trim();
  if(!dev || !name) return;
  dev.zones = dev.zones || [];
  dev.zones.push({ id: uid(), name, children: [] });
  save(); closeModal(); renderAll(); toast(`✅ 已添加分区「${name}」`);
}

/* 在某个室下面添加分层（第一层、第二层…） */
function openLayerAddForm(deviceId, roomId){
  const dev = deviceById(deviceId);
  const f = dev ? findZoneInDevice(dev, roomId) : null;
  if(!f || !f.isRoom) return;
  openModal(`
    <div class="modal-head"><h2>＋ 添加分层（${esc(dev.name)} · ${esc(f.room.name)}）</h2><button class="close-x" data-action="close-modal">✕</button></div>
    <div class="modal-body">
      <form data-form="layer-add" data-device="${dev.id}" data-room="${roomId}">
        <div class="field"><label>分层名称 *</label><input name="ln" required placeholder="如：第一层、第二层、门架…"></div>
      </form>
    </div>
    <div class="modal-foot">
      <button class="btn" data-action="close-modal">取消</button>
      <button class="btn btn-primary" data-action="submit-layer-add" data-device="${dev.id}" data-room="${roomId}">添加</button>
    </div>`);
}

function submitLayerAddFromForm(form){
  if(!form) return;
  const dev = deviceById(form.dataset.device);
  const f = dev ? findZoneInDevice(dev, form.dataset.room) : null;
  const name = form.querySelector('[name=ln]').value.trim();
  if(!f || !f.isRoom || !name) return;
  f.room.children = f.room.children || [];
  f.room.children.push({ id: uid(), name, children: [] });
  save(); closeModal(); renderAll(); toast(`✅ 已添加分层「${name}」`);
}

/* 删除分区/分层：询问是否连食材一起删（默认保留食材） */
function openZoneDeleteModal(deviceId, zoneId){
  const dev = deviceById(deviceId);
  const f = dev ? findZoneInDevice(dev, zoneId) : null;
  if(!dev || !f) return;
  const ids = new Set([f.zone.id, ...(f.zone.children || []).map(c => c.id)]);
  const count = state.ingredients.filter(it => it.deviceId === deviceId && ids.has(it.zoneId)).length;
  const kindName = f.isRoom ? '分区' : '分层';
  openModal(`
    <div class="modal-head"><h2>🗑 删除${kindName}「${esc(f.zone.name)}」</h2><button class="close-x" data-action="close-modal">✕</button></div>
    <div class="modal-body">
      <div style="margin-bottom:10px;">${f.isRoom && (f.zone.children || []).length ? `它包含 <b>${f.zone.children.length}</b> 个分层，` : ''}里面有 <b>${count}</b> 种食材。</div>
      <label style="display:flex; align-items:center; gap:8px; padding:10px 12px; background:var(--red-bg); border-radius:10px; cursor:pointer;">
        <input type="checkbox" id="delZoneItems" style="width:auto;">
        <span style="font-size:14px;">同时删除这些食材</span>
      </label>
      <div class="hint" style="margin-top:8px;">默认不勾选：食材会保留，移到「未分区」，之后可以再分配位置。</div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-action="close-modal">取消</button>
      <button class="btn btn-danger" data-action="submit-del-zone" data-device="${deviceId}" data-zone="${zoneId}">确认删除</button>
    </div>`);
}

function openDeviceForm(id){
  const dev = id ? deviceById(id) : null;
  openModal(`
    <div class="modal-head"><h2>${dev ? '给设备改名' : '添加冰箱 / 冰柜'}</h2><button class="close-x" data-action="close-modal">✕</button></div>
    <div class="modal-body">
      <form data-form="device">
        <input type="hidden" name="id" value="${dev ? dev.id : ''}">
        <div class="field"><label>名称 *</label><input name="name" required value="${dev ? esc(dev.name) : ''}" placeholder="如：冰箱、冰柜、阳台储物柜"></div>
        ${dev ? '' : '<div class="hint" style="margin-top:8px;">添加后默认带"冷藏室 / 冷冻室"，可再细分分层。</div>'}
      </form>
    </div>
    <div class="modal-foot">
      <button class="btn" data-action="close-modal">取消</button>
      <button class="btn btn-primary" data-action="submit-device">${dev ? '保存' : '添加'}</button>
    </div>`);
}

function openZoneEditForm(deviceId, zoneId){
  const dev = deviceById(deviceId);
  const f = dev ? findZoneInDevice(dev, zoneId) : null;
  if(!dev || !f) return;
  const kindName = f.isRoom ? '分区' : '分层';
  openModal(`
    <div class="modal-head"><h2>修改${kindName}名（${esc(dev.name)}${f.isRoom ? '' : ' · ' + esc(f.room.name)}）</h2><button class="close-x" data-action="close-modal">✕</button></div>
    <div class="modal-body">
      <form data-form="zone-edit">
        <input type="hidden" name="deviceId" value="${dev.id}">
        <input type="hidden" name="zoneId" value="${f.zone.id}">
        <div class="field"><label>${kindName}名称 *</label><input name="name" required value="${esc(f.zone.name)}"></div>
      </form>
    </div>
    <div class="modal-foot">
      <button class="btn" data-action="close-modal">取消</button>
      <button class="btn btn-primary" data-action="submit-zone-edit">保存</button>
    </div>`);
}

/* 点分区/分层"查看"：直接弹窗显示这里的食材（室会按分层分组显示） */
function openZoneItemsModal(deviceId, zoneId){
  const dev = deviceById(deviceId);
  const f = dev ? findZoneInDevice(dev, zoneId) : null;
  if(!dev || !f) return;
  zoneModal = { deviceId, zoneId };
  const emptyHtml = `
        <div class="empty" style="padding:26px 10px;">
          <span class="empty-emoji">🈳</span>
          <b>这里还空着</b>
          <p>把放进去的食材记一笔吧</p>
          <button class="btn btn-primary" data-action="add-ingredient-zone" data-device="${deviceId}" data-zone="${zoneId}">＋ 往这里添加食材</button>
        </div>`;
  let body = '';
  let total = 0;
  if(f.isRoom){
    const direct = state.ingredients.filter(it => it.deviceId === deviceId && it.zoneId === zoneId);
    const kids = f.zone.children || [];
    total += direct.length;
    if(direct.length) body += `<div class="zone-head">未细分到分层</div><div class="ing-list">${direct.map(ingRow).join('')}</div>`;
    for(const c of kids){
      const cItems = state.ingredients.filter(it => it.deviceId === deviceId && it.zoneId === c.id);
      total += cItems.length;
      if(cItems.length) body += `<div class="zone-head">${esc(c.name)}</div><div class="ing-list">${cItems.map(ingRow).join('')}</div>`;
    }
    if(!body) body = emptyHtml;
  } else {
    const items = state.ingredients.filter(it => it.deviceId === deviceId && it.zoneId === zoneId);
    total = items.length;
    body = items.length ? `<div class="ing-list">${items.map(ingRow).join('')}</div>` : emptyHtml;
  }
  openModal(`
    <div class="modal-head"><h2>❄️ ${esc(dev.name)} · 🗄 ${esc(f.zone.name)}</h2><button class="close-x" data-action="close-zone-modal">✕</button></div>
    <div class="modal-body">${body}</div>
    <div class="modal-foot">
      <span class="hint" style="margin-right:auto; align-self:center;">共 ${total} 种 · 可直接 ＋/− 改数量</span>
      <button class="btn" data-action="goto-zone-pantry" data-device="${deviceId}" data-zone="${zoneId}">在食材页中查看</button>
    </div>`);
  zoneModalVisible = true;
}

/* ---------------- 菜谱页 ---------------- */

function viewRecipes(){
  return `
    <div class="fixed-part">
      <div class="page-head">
        <div><h1>📖 菜谱库</h1><p>内置 ${RECIPES.length} 道家常菜${state.customRecipes.length ? ` + 自己的 ${state.customRecipes.length} 道` : ''}</p></div>
        <div class="item-actions">
          <button class="btn" data-action="open-batch-import">📥 批量导入</button>
          <button class="btn btn-primary" data-action="open-recipe-form">＋ 添加我的菜谱</button>
        </div>
      </div>
      <div class="card">
        <input type="search" placeholder="🔍 搜索菜名或标签…" value="${esc(recipeSearch)}" data-input="recipe-search">
        <div class="scroll-chips" style="margin-top:10px;">
          <span class="chip clickable ${recipeTag === 'all' ? 'active' : ''}" data-action="recipe-tag" data-t="all">全部</span>
          ${TAG_FILTERS.map(t => `<span class="chip clickable ${recipeTag === t ? 'active' : ''}" data-action="recipe-tag" data-t="${t}">${t}</span>`).join('')}
        </div>
      </div>
    </div>
    <div class="scroll-area">
      <div id="recipe-results">${recipeResultsHtml()}</div>
    </div>`;
}

const TAG_FILTERS = ['荤菜','素菜','汤羹','主食','凉菜','快手','下饭','硬菜'];

/* 菜谱列表结果区（搜索时只刷新这一块，不打断输入） */
function recipeResultsHtml(){
  const all = ALL_RECIPES();
  let list = all;
  if(recipeSearch.trim()){
    const q = recipeSearch.trim().toLowerCase();
    list = list.filter(r => r.name.toLowerCase().includes(q) || (r.tags || []).some(t => t.toLowerCase().includes(q)));
  }
  if(recipeTag !== 'all') list = list.filter(r => (r.tags || []).includes(recipeTag));

  const pantry = buildPantry(state.ingredients);
  const ctx = buildCtx();
  const entries = list
    .map(r => ({ recipe: r, a: analyzeRecipe(r, pantry, state.settings.servings || 2, ctx) }))
    .sort((x, y) => y.a.score - x.a.score || y.a.coverage - x.a.coverage);

  return `
    <div class="grid">
      ${entries.length ? entries.map(recipeCard).join('') : `
        <div class="empty" style="grid-column:1/-1;"><span class="empty-emoji">📖</span><b>没有找到菜谱</b><p>换个关键词试试</p></div>`}
    </div>`;
}

/* 自定义菜谱表单 */
function openRecipeForm(id){
  const r = id ? recipeById(id) : null;
  if(id && !r) return;
  const TAGS = ['荤菜','素菜','汤羹','主食','凉菜','快手','下饭','硬菜','微辣','宴客'];
  const ingRows = (r ? r.ingredients : [{},{},{}]).map(ing => ingFormRow(ing)).join('');
  openModal(`
    <div class="modal-head"><h2>${r ? '编辑菜谱' : '添加我的菜谱'}</h2><button class="close-x" data-action="close-modal">✕</button></div>
    <div class="modal-body">
      <form data-form="recipe" id="recipeForm">
        <input type="hidden" name="id" value="${r ? r.id : ''}">
        <div class="form-grid">
          <div class="field"><label>菜名 *</label><input name="name" required value="${r ? esc(r.name) : ''}" placeholder="如：妈妈的青椒鸡蛋"></div>
          <div class="field"><label>大约耗时（分钟）</label><input name="time" type="number" min="1" value="${r ? r.time || 15 : 15}"></div>
          <div class="field"><label>菜谱按几人份写的</label><input name="baseServings" type="number" min="1" value="${r ? r.baseServings || 2 : 2}"></div>
          <div class="field"><label>难度</label>
            <select name="difficulty">
              ${['简单','中等','进阶'].map(d => `<option ${r && r.difficulty === d ? 'selected' : ''}>${d}</option>`).join('')}
            </select></div>
          <div class="field full"><label>标签（至少选一个）</label>
            <div class="tag-checks">
              ${TAGS.map(t => `<label><input type="checkbox" name="tags" value="${t}" ${r && (r.tags || []).includes(t) ? 'checked' : ''}>${t}</label>`).join('')}
            </div></div>
          <div class="field full"><label>食材（菜里用到的主料和配料）</label>
            <div class="ingform-rows" id="ingRows">${ingRows}</div>
            <button type="button" class="btn btn-sm" data-action="add-ing-row" style="margin-top:8px;">＋ 加一行食材</button></div>
          <div class="field full"><label>调料（逗号分隔，默认家里常备）</label>
            <input name="seasonings" value="${r ? esc((r.seasonings || []).join('、')) : ''}" placeholder="盐、生抽、食用油…"></div>
          <div class="field full"><label>做法步骤（每行一步）</label>
            <textarea name="steps" rows="5" placeholder="第一步…&#10;第二步…">${r ? esc((r.steps || []).join('\n')) : ''}</textarea></div>
        </div>
      </form>
    </div>
    <div class="modal-foot">
      <button class="btn" data-action="close-modal">取消</button>
      <button class="btn btn-primary" data-action="submit-recipe">${r ? '保存修改' : '添加菜谱'}</button>
    </div>`);
}

function ingFormRow(ing){
  ing = ing || {};
  return `
    <div class="ingform-row">
      <input name="i_name" data-suggest="ingredient" autocomplete="off" placeholder="食材名" value="${esc(ing.name || '')}">
      <input name="i_amount" type="number" step="any" min="0" placeholder="数量" value="${ing.amount ?? ''}">
      <input name="i_unit" data-suggest="unit" autocomplete="off" placeholder="单位" value="${esc(ing.unit || '')}">
      <button type="button" class="rm" data-action="rm-ing-row" title="删除这行">✕</button>
    </div>
    <label style="display:flex; align-items:center; gap:5px; font-size:12px; color:var(--sub); margin:-4px 0 0 2px;">
      <input type="checkbox" name="i_optional" style="width:auto;" ${ing.optional ? 'checked' : ''}> 可选配料（没有也能做）
    </label>`;
}

/* ---------------- 设置页 ---------------- */

function viewSettings(){
  return `
    <div class="page-head"><div><h1>⚙️ 设置</h1><p>数据备份与说明</p></div></div>

    <div class="card">
      <h3 style="margin:0 0 6px; font-size:16px;">🤖 AI 助手</h3>
      <div class="hint" style="margin-bottom:10px;">AI 助手（右下角 🤖）默认使用<b>离线指令解析</b>，不用联网也能听懂常用指令。填入<b>智谱 AI</b> 的 API Key 后，会用大模型理解更随意的表达（语音/文字都行）；食材数据只把<b>摘要</b>发给智谱，不会上传其他内容。</div>
      <div class="set-row">
        <div><b>智谱 API Key（可选）</b><div class="set-desc">在 bigmodel.cn 免费注册获取，仅保存在本机浏览器</div></div>
        <input type="password" id="aiApiKey" value="${esc(state.settings.aiApiKey || '')}" placeholder="粘贴 API Key" style="max-width:240px;">
      </div>
      <div class="set-row">
        <div><b>模型</b><div class="set-desc">以下模型均免费</div></div>
        <select id="aiModel" style="max-width:200px;">
          ${['glm-4-flash','glm-4.7-flash','glm-4.5-flash'].map(m => `<option ${state.settings.aiModel === m ? 'selected' : ''}>${m}</option>`).join('')}
        </select>
      </div>
      <div class="set-row">
        <div><b>保存 AI 设置</b><div class="set-desc">保存后即可在对话里用大模型理解任意说法</div></div>
        <button class="btn btn-primary" data-action="save-ai-settings">保存</button>
      </div>
    </div>

    <div class="card">
      <h3 style="margin:0 0 6px; font-size:16px;">💾 数据备份</h3>
      <div class="hint" style="margin-bottom:10px;">你的数据只保存在<b>当前这台设备的当前浏览器</b>里。清理浏览器缓存、换浏览器或换电脑后数据不会跟过去，请定期导出备份。</div>
      <div class="set-row">
        <div><b>导出备份</b><div class="set-desc">下载一个 JSON 文件，存到微信/U盘都行</div></div>
        <button class="btn" data-action="export-data">⬇️ 导出</button>
      </div>
      <div class="set-row">
        <div><b>导入备份</b><div class="set-desc">选择之前导出的文件，会覆盖当前数据</div></div>
        <input type="file" accept=".json,application/json" data-change="import-file" style="max-width:200px;">
      </div>
      <div class="set-row">
        <div><b>清空所有数据</b><div class="set-desc">删掉全部食材、分区和自定义菜谱，不可恢复</div></div>
        <button class="btn btn-danger" data-action="clear-all">🗑 清空</button>
      </div>
    </div>

    <div class="card">
      <h3 style="margin:0 0 6px; font-size:16px;">🧂 调料匹配</h3>
      <div class="set-row" style="border-bottom:0; padding-top:0;">
        <div><b>调料参与匹配</b><div class="set-desc">${state.settings.seasoningsMatter
          ? '已开启：菜谱里的调料（盐、生抽、豆瓣酱…）需要在「食材」里记录过才算有。'
          : '已关闭：默认所有调料家里常备，不参与匹配。家里调料不全？开启它，并先把你的调料加进「食材」（分类选调味料）。'}</div></div>
        <button class="btn ${state.settings.seasoningsMatter ? 'btn-primary' : ''}" data-action="toggle-seasonings">${state.settings.seasoningsMatter ? '✓ 已开启' : '已关闭'}</button>
      </div>
      <div class="hint" style="line-height:1.9;">常见调料参考：${ASSUMED_SEASONINGS.map(s => esc(s)).join('、')}</div>
    </div>

    <div class="card">
      <h3 style="margin:0 0 6px; font-size:16px;">ℹ️ 关于</h3>
      <div class="hint" style="line-height:1.9;">
        食材管家 v${APP_VERSION} · 内置菜谱 ${RECIPES.length} 道，自定义 ${state.customRecipes.length} 道<br>
        数据文件：浏览器本地存储（键名 ${STORE_KEY}）<br>
        想在手机上用：手机浏览器打开同一页面即可，但数据各自独立；进阶可用「局域网共享」方式（见使用说明）。
      </div>
    </div>`;
}

/* ---------------- 数据导入导出 ---------------- */

function exportData(){
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const d = new Date();
  a.download = `食材管家备份-${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast('📦 备份文件已开始下载');
}

function importData(file){
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const obj = JSON.parse(reader.result);
      if(!obj || !Array.isArray(obj.devices) || !Array.isArray(obj.ingredients)) throw new Error('bad');
      const ok = await confirmModal({
        title: '导入备份',
        html: `将导入 <b>${obj.ingredients.length}</b> 种食材、<b>${(obj.devices || []).length}</b> 个设备，并<b>覆盖</b>当前所有数据，确定吗？`,
        okText: '导入', danger: true
      });
      if(!ok) return;
      state = migrate(obj);
      save();
      renderAll();
      toast('✅ 导入成功');
    } catch(e){
      toast('❌ 文件格式不对，导入失败');
    }
  };
  reader.readAsText(file);
}

/* ---------------- 批量导入菜谱（配合 AI 搜集：让 ZCode 生成 JSON 后粘贴进来） ---------------- */

function openBatchImport(){
  openModal(`
    <div class="modal-head"><h2>📥 批量导入菜谱</h2><button class="close-x" data-action="close-modal">✕</button></div>
    <div class="modal-body">
      <div class="hint" style="margin-bottom:8px; line-height:1.8;">粘贴<b>JSON 数组</b>（每道菜一个对象）。中国菜太多？你可以让 ZCode 等 AI 助手「帮我找几道 XX 菜谱，按下面的格式生成 JSON」，把结果粘贴到这里即可入库。重名的菜会自动跳过。</div>
      <details style="margin-bottom:10px;">
        <summary class="hint" style="cursor:pointer; user-select:none;">📄 查看格式示例</summary>
        <pre style="font-size:11px; background:#f7f4ee; padding:10px; border-radius:10px; overflow-x:auto; line-height:1.6;">[{
  "name": "辣椒炒肉",
  "tags": ["荤菜","快手"],
  "baseServings": 2, "time": 20, "difficulty": "简单",
  "ingredients": [
    {"name":"猪肉","amount":300,"unit":"克"},
    {"name":"青椒","amount":5,"unit":"个"},
    {"name":"蒜","amount":3,"unit":"瓣","optional":true}
  ],
  "seasonings": ["生抽","老抽","豆豉"],
  "steps": ["猪肉切片腌10分钟","热油下肉片煸出油","下青椒蒜片炒断生","加调料炒匀出锅"]
}]</pre>
      </details>
      <textarea id="batchJson" rows="10" placeholder='[{ "name": "菜名", … }]'></textarea>
    </div>
    <div class="modal-foot">
      <button class="btn" data-action="close-modal">取消</button>
      <button class="btn btn-primary" data-action="do-batch-import">解析并导入</button>
    </div>`);
}

function doBatchImport(){
  const ta = document.getElementById('batchJson');
  if(!ta || !ta.value.trim()){ toast('请先粘贴 JSON 内容'); return; }
  let arr;
  try { arr = JSON.parse(ta.value); }
  catch(e){ toast('❌ JSON 格式不对，请检查（可用 AI 帮你校验）'); return; }
  if(!Array.isArray(arr)) arr = [arr];

  const added = [], skipped = [];
  for(const raw of arr){
    if(!raw || !String(raw.name || '').trim()){ skipped.push('(无名条目)'); continue; }
    const name = String(raw.name).trim();
    if(ALL_RECIPES().some(r => r.name === name)){ skipped.push(name + '（重名）'); continue; }
    const ingredients = (Array.isArray(raw.ingredients) ? raw.ingredients : [])
      .map(i => ({
        name: String((i && i.name) || '').trim(),
        amount: (i && typeof i.amount === 'number') ? i.amount : ((i && i.amount && isFinite(Number(i.amount))) ? Number(i.amount) : null),
        unit: String((i && i.unit) || '').trim(),
        optional: !!(i && i.optional)
      }))
      .filter(i => i.name);
    if(!ingredients.length){ skipped.push(name + '（没有食材）'); continue; }
    let tags = Array.isArray(raw.tags) ? raw.tags.map(String) : String(raw.tags || '').split(/[,，、]+/);
    tags = tags.map(t => t.trim()).filter(Boolean);
    if(!tags.length) tags = ['素菜'];
    let steps = Array.isArray(raw.steps) ? raw.steps.map(String) : String(raw.steps || '').split(/\n+/);
    steps = steps.map(s => s.trim()).filter(Boolean);
    let seasonings = Array.isArray(raw.seasonings) ? raw.seasonings.map(String) : String(raw.seasonings || '').split(/[,，、]+/);
    seasonings = seasonings.map(s => s.trim()).filter(Boolean);

    state.customRecipes.push({
      id: uid(), custom: true, name, tags,
      baseServings: Math.max(1, Number(raw.baseServings) || 2),
      time: Math.max(1, Number(raw.time) || 15),
      difficulty: ['简单','中等','进阶'].includes(raw.difficulty) ? raw.difficulty : '简单',
      ingredients, seasonings, steps
    });
    added.push(name);
  }
  if(!added.length){ toast(`没有可导入的菜谱（跳过 ${skipped.length} 条）`); return; }
  save();
  closeModal();
  renderAll();
  toast(`✅ 导入 ${added.length} 道菜谱${skipped.length ? `，跳过 ${skipped.length} 条` : ''}`);
}

/* ---------------- 做完菜扣减库存 ---------------- */

function planDeduction(recipe, servings){
  const pantry = buildPantry(state.ingredients);
  const rows = [], skipped = [];
  for(const ing of (recipe.ingredients || []).filter(i => !i.optional)){
    const p = pantry[normalizeName(ing.name)];
    if(!p){ skipped.push({ label: ing.name, why: '家里没有记录' }); continue; }
    if(typeof ing.amount !== 'number'){ skipped.push({ label: ing.name, why: '菜谱没写用量' }); continue; }
    let remaining = scaledAmount(recipe, ing, servings);
    const items = p.items.slice().sort((a, b) => {
      const da = a.expiry ? daysUntil(a.expiry) : Infinity;
      const db = b.expiry ? daysUntil(b.expiry) : Infinity;
      return da - db;
    });
    let took = 0;
    for(const item of items){
      if(remaining <= 0) break;
      if(typeof item.qty !== 'number') continue;
      if(item.unit && ing.unit && item.unit !== ing.unit) continue;
      const take = Math.min(item.qty, remaining);
      if(take <= 0) continue;
      rows.push({ item, ing, take, after: roundQty(item.qty - take) });
      remaining = roundQty(remaining - take);
      took += take;
    }
    if(took <= 0 && remaining > 0){
      skipped.push({ label: ing.name, why: '单位对不上或没记数量，无法自动扣' });
    } else if(remaining > 0){
      skipped.push({ label: ing.name, why: `库存不够（需 ${fmtQty(scaledAmount(recipe, ing, servings))}${ing.unit || ''}），会按现有的扣` });
    }
  }
  return { rows, skipped };
}

async function doDeduct(id){
  const r = recipeById(id);
  if(!r) return;
  const servings = state.settings.servings || 2;
  const plan = planDeduction(r, servings);
  if(!plan.rows.length){
    toast('🤔 没找到能自动扣减的食材（名称/单位对不上）');
    return;
  }
  const listHtml = plan.rows.map(x => `
    <div style="padding:5px 0; border-bottom:1px dashed var(--line-soft);">
      ${esc(x.ing.name)}：${fmtQty(x.item.qty)}${esc(x.item.unit || '')} → <b>${x.after <= 0.01 ? '用完（移除）' : fmtQty(x.after) + esc(x.item.unit || '')}</b>
    </div>`).join('');
  const skipHtml = plan.skipped.length
    ? `<div class="hint" style="margin-top:10px;">不自动扣减：${plan.skipped.map(s => `${esc(s.label)}（${esc(s.why)}）`).join('；')}。可选配料也不扣。</div>`
    : `<div class="hint" style="margin-top:10px;">可选配料与调料不扣减。</div>`;
  const ok = await confirmModal({
    title: `做完「${r.name}」（${servings}人份）`,
    html: `<div>将做如下扣减：</div>${listHtml}${skipHtml}`,
    okText: '确认扣减', danger: true
  });
  if(!ok) return;
  for(const x of plan.rows){
    const it = state.ingredients.find(i => i.id === x.item.id);
    if(!it) continue;
    it.qty = roundQty(it.qty - x.take);
    if(it.qty <= 0.01) state.ingredients = state.ingredients.filter(i => i.id !== it.id);
  }
  save();
  closeModal();
  toast(`✅ 已按 ${servings} 人份扣减「${r.name}」的食材`);
  renderAll();
}

/* ---------------- 智能配餐 / 今日菜单 ---------------- */

/* 菜品道数：用户最后调整的是"菜品数量"就用它；最后调整的是"就餐人数"则按人数换算
   （1-2人3道、3-4人5道、5人以上8道） */
function defaultDishCount(){
  const s = state.settings.servings || 2;
  return s <= 2 ? 3 : s <= 4 ? 5 : 8;
}
function getEffectiveDishCount(){
  const st = state.settings;
  return (st.lastAdjusted === 'dishCount' && st.dishCount) ? st.dishCount : defaultDishCount();
}

/* 模式选择弹窗：点选即切换，当前模式打勾 */
function openModeModal(){
  const mode = state.settings.composeMode || 'smart';
  const modes = [
    { id:'smart',  emoji:'✨', name:'智能配餐', desc:'按你现有食材的匹配度优先搭配' },
    { id:'random', emoji:'🎲', name:'随机配餐', desc:'不看库存，从全部菜谱随机选' },
    { id:'veg',    emoji:'🥬', name:'今日吃素', desc:'以素菜为主，可选是否考虑已有食材' },
    { id:'meat',   emoji:'🍖', name:'今日吃肉', desc:'以荤菜为主，可选是否考虑已有食材' }
  ];
  openModal(`
    <div class="modal-head"><h2>🔀 选择配餐模式</h2><button class="close-x" data-action="close-modal">✕</button></div>
    <div class="modal-body">
      ${modes.map(m => `
        <button class="btn btn-block menu-btn ${mode === m.id ? 'mode-active' : ''}" data-action="set-mode" data-mode="${m.id}">
          <span>${m.emoji} <b>${m.name}</b>${mode === m.id ? ' ✓' : ''}</span>
          <span class="hint">${m.desc}</span>
        </button>`).join('')}
      <div class="hint" style="margin-top:6px;">选好模式后，点右上角按钮生成今日菜单；吃素/吃肉模式可在控制区选择是否考虑已有食材。</div>
    </div>`);
}

/* 按 当前模式 + 锁定的菜 重新生成今日菜单（锁定的保持不变） */
function recomposeMenu(){
  const mode = state.settings.composeMode || 'smart';
  const count = getEffectiveDishCount();
  const pantry = buildPantry(state.ingredients);
  const servings = state.settings.servings || 2;
  const ctx = buildCtx();
  const locked = (state.todayMenu || []).filter(m => m.locked);
  const lockedIds = new Set(locked.map(m => m.id));
  const need = Math.max(0, count - locked.length);
  let picked = [];
  if(mode === 'random') picked = composeRandom(need, lockedIds);
  else if(mode === 'veg') picked = composeByTag(pantry, need, servings, ctx, '素菜', state.settings.vegMeatConsiderStock !== false, lockedIds);
  else if(mode === 'meat') picked = composeByTag(pantry, need, servings, ctx, '荤菜', state.settings.vegMeatConsiderStock !== false, lockedIds);
  else picked = composeMenu(pantry, need, servings, ctx, lockedIds);
  state.todayMenu = locked
    .map(m => ({ id: m.id, portions: 1, locked: true }))
    .concat(picked.map(r => ({ id: r.id, portions: 1, locked: false })));
  save();
  if(need === 0 && locked.length) toast('🔒 锁定的菜已占满菜品数量，可解锁几道或调大数量');
}

/* 加入 / 移出今日菜单 */
function toggleTodayMenu(id){
  const list = state.todayMenu || (state.todayMenu = []);
  const i = list.findIndex(m => m.id === id);
  if(i >= 0){
    list.splice(i, 1);
    toast('已从今日菜单移除');
  } else {
    list.push({ id, portions: 1 });
    toast('✅ 已加入今日菜单，去推荐页调整份数');
  }
  save();
}

/* ---------------- 复制缺少清单 ---------------- */

async function copyMissing(id){
  const r = recipeById(id);
  if(!r) return;
  const servings = state.settings.servings || 2;
  const a = analyzeRecipe(r, buildPantry(state.ingredients), servings, buildCtx());
  const lines = [`【${r.name}（${servings}人份）还需准备】`];
  a.missing.forEach(m => lines.push(`- ${m.name}：缺${m.amount ? '（需 ' + fmtQty(scaledAmount(r, m, servings)) + (m.unit || '') + '）' : ''}`));
  a.short.forEach(s => lines.push(`- ${s.ing.name}：需要${fmtQty(s.need)}${s.ing.unit || ''}，现有${fmtQty(s.have)}${s.ing.unit || ''}`));
  if(lines.length === 1){ toast('🎉 这道菜的食材都齐了！'); return; }
  const text = lines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast('📋 已复制到剪贴板');
  } catch(e){
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('📋 已复制到剪贴板'); }
    catch(e2){ toast('复制失败，请手动抄录'); }
    ta.remove();
  }
}

/* ---------------- 快捷数量加减 ---------------- */

function qtyAdjust(id, delta){
  const it = state.ingredients.find(x => x.id === id);
  if(!it) return;
  const step = (it.unit === '克' || it.unit === '毫升') ? 50 : 1;
  if(typeof it.qty !== 'number'){ it.qty = step > 1 ? 50 : 1; }
  else it.qty = roundQty(it.qty + delta * step);
  if(it.qty <= 0){
    state.ingredients = state.ingredients.filter(x => x.id !== id);
    toast(`🧹 ${it.name} 用完了，已移除`);
  }
  save();
  renderAll();
}

/* ---------------- 快捷添加常用分区名 ---------------- */

const ZONE_PRESETS = ['冷藏-上层第一层','冷藏-上层第二层','冷藏-中层','冷藏-下层','冷冻室','左侧门','右侧门','抽屉-保鲜','抽屉-冷冻'];

/* ---------------- 输入联想 ---------------- */

function refreshDatalists(){
  const dl = document.getElementById('dl-ingredients');
  const names = new Set();
  for(const cat in COMMON_INGREDIENTS) COMMON_INGREDIENTS[cat].forEach(n => names.add(n));
  state.ingredients.forEach(it => names.add(it.name));
  dl.innerHTML = [...names].map(n => `<option value="${esc(n)}">`).join('');
  const du = document.getElementById('dl-units');
  du.innerHTML = COMMON_UNITS.map(u => `<option value="${esc(u)}">`).join('');
}

/* ---------------- 自绘联想下拉（替代浏览器datalist，可滚动、可控样式） ---------------- */

let suggestFor = null;
let suggestItems = [];
let suggestActive = -1;

function categoryOf(name){
  return NAME_CATEGORY[normalizeName(name)];
}

function closeSuggest(){
  const b = document.getElementById('suggestBox');
  if(b){ b.style.display = 'none'; b.innerHTML = ''; }
  suggestFor = null; suggestItems = []; suggestActive = -1;
}

function showSuggest(input, fullList){
  const type = input.dataset.suggest;
  // 单位框：记录本次候选的基准单位（克/斤/公斤/千克 间切换时用于换算数量）
  if(type === 'unit') input.dataset.wprev = input.value.trim();
  const val = fullList ? '' : (input.value || '').trim().toLowerCase();
  let pool = [];
  if(type === 'ingredient'){
    const names = new Set();
    for(const cat in COMMON_INGREDIENTS) COMMON_INGREDIENTS[cat].forEach(n => names.add(n));
    state.ingredients.forEach(it => it.name && names.add(it.name));
    (state.customRecipes || []).forEach(r => (r.ingredients || []).forEach(i => i.name && names.add(i.name)));
    pool = [...names];
  } else if(type === 'unit'){
    pool = COMMON_UNITS.slice();
  } else { closeSuggest(); return; }

  suggestItems = pool.filter(n => n.toLowerCase().includes(val) && (fullList || n.toLowerCase() !== val)).slice(0, 30);
  const b = document.getElementById('suggestBox');
  if(!suggestItems.length || !b){ closeSuggest(); return; }

  b.innerHTML = suggestItems.map((n, i) => {
    const emoji = type === 'ingredient' ? (CATEGORY_EMOJI[categoryOf(n)] || '📦') : '';
    return `<div class="suggest-item" data-si="${i}">${emoji ? emoji + ' ' : ''}${esc(n)}</div>`;
  }).join('');
  b.style.display = 'block';
  suggestFor = input;
  suggestActive = -1;
  positionSuggest();
  // 弹窗有 0.2s 滑入动画，动画结束后再校准一次位置
  setTimeout(positionSuggest, 260);
}

/* 计算联想下拉位置：手机端显示在输入框上方（避开键盘、方便拇指点选），电脑端优先下方、空间不足时放上方 */
function positionSuggest(){
  if(!suggestFor) return;
  const b = document.getElementById('suggestBox');
  if(!b || b.style.display === 'none') return;
  const rect = suggestFor.getBoundingClientRect();
  if(rect.bottom < 0 || rect.top > window.innerHeight){ closeSuggest(); return; }
  b.style.left = rect.left + 'px';
  b.style.width = Math.max(rect.width, 170) + 'px';
  const bh = b.offsetHeight || Math.min(220, suggestItems.length * 40 + 10);
  const isMobile = window.matchMedia('(max-width: 720px)').matches;
  if(isMobile || rect.bottom + bh + 10 > window.innerHeight){
    b.style.top = Math.max(6, rect.top - bh - 6) + 'px';
  } else {
    b.style.top = rect.bottom + 4 + 'px';
  }
}

function pickSuggest(idx){
  if(!suggestFor || !suggestItems[idx]) return;
  const input = suggestFor; // 先保存引用（closeSuggest 会清空 suggestFor）
  input.value = suggestItems[idx];
  const isUnit = input.name === 'unit';
  closeSuggest();
  input.focus();
  if(isUnit){
    convertWeightUnit(input); // 单位：选完立即按重量单位换算数量
  } else {
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

/* 克/斤/公斤/千克 之间切换单位时，数量自动换算（其他单位不换算） */
function convertWeightUnit(unitInput){
  const form = unitInput.closest('form');
  if(!form) return;
  const qtyInput = form.querySelector('[name=qty]');
  if(!qtyInput) return;
  const newUnit = unitInput.value.trim();
  const oldUnit = unitInput.dataset.wprev || '';
  const bothWeight = (oldUnit in WEIGHT_FACTORS) && (newUnit in WEIGHT_FACTORS);
  const q = Number(qtyInput.value);
  if(bothWeight && oldUnit !== newUnit && isFinite(q) && q > 0){
    const grams = q * WEIGHT_FACTORS[oldUnit];
    qtyInput.value = Math.round(grams / WEIGHT_FACTORS[newUnit] * 100) / 100;
  }
  // 无论是否换算，基准都更新为当前单位
  unitInput.dataset.wprev = newUnit;
}

document.addEventListener('focusin', e => {
  const el = e.target;
  if(el && el.dataset && el.dataset.suggest){
    // 记住聚焦时的单位，便于在 克/斤/公斤/千克 间切换时换算数量
    if(el.dataset.suggest === 'unit') el.dataset.wprev = el.value.trim();
    showSuggest(el, true); // 点击/聚焦时显示完整候选栏
  }
  else closeSuggest();
});
document.addEventListener('mousedown', e => {
  if(e.target.closest && e.target.closest('.suggest-item')) e.preventDefault(); // 先保住输入框焦点
});
document.addEventListener('click', e => {
  const item = e.target.closest('.suggest-item');
  if(item){ pickSuggest(Number(item.dataset.si)); return; }
  if(e.target.closest && e.target.closest('#suggestBox')) return; // 点框内滚动条/空白不关闭
  const sugInput = e.target.closest && e.target.closest('[data-suggest]');
  if(sugInput && sugInput.tagName === 'INPUT'){
    // 已持有焦点时再次点击不会再触发 focusin，这里兜底弹出完整候选栏
    const b = document.getElementById('suggestBox');
    if(!suggestFor || suggestFor !== sugInput || b.style.display === 'none') showSuggest(sugInput, true);
    return;
  }
  if(!e.target.closest || !e.target.closest('[data-suggest]')) closeSuggest();
});
/* 滚动/缩放时下拉跟随输入框重新定位（在框内滚动不会被误关） */
document.addEventListener('scroll', () => { if(suggestFor) positionSuggest(); }, true);
window.addEventListener('resize', () => { if(suggestFor) positionSuggest(); });

document.addEventListener('keydown', e => {
  const b = document.getElementById('suggestBox');
  if(!suggestFor || !b || b.style.display === 'none') return;
  if(e.key === 'Escape'){ closeSuggest(); return; }
  if(e.key === 'ArrowDown' || e.key === 'ArrowUp'){
    e.preventDefault();
    suggestActive = e.key === 'ArrowDown'
      ? Math.min(suggestItems.length - 1, suggestActive + 1)
      : Math.max(0, suggestActive - 1);
    [...b.children].forEach((c, i) => c.classList.toggle('active', i === suggestActive));
    const act = b.children[suggestActive];
    if(act) act.scrollIntoView({ block: 'nearest' });
  } else if(e.key === 'Enter' && suggestActive >= 0){
    e.preventDefault();
    pickSuggest(suggestActive);
  }
});

/* ---------------- 表单提交 ---------------- */

function submitIngredient(form){
  const fd = new FormData(form);
  const name = (fd.get('name') || '').trim();
  if(!name){ toast('请填写食材名称'); return; }
  const qtyRaw = (fd.get('qty') || '').toString().trim();
  const qty = qtyRaw === '' ? null : Number(qtyRaw);
  if(qty !== null && (!isFinite(qty) || qty < 0)){ toast('数量格式不对'); return; }
  const deviceId = (fd.get('deviceId') || '') || null;
  const zoneId = (fd.get('zoneId') || '') || null;
  const category = (fd.get('category') || '') || NAME_CATEGORY[normalizeName(name)] || '其他';
  const id = fd.get('id');
  const data = {
    name, qty: (qty !== null && isFinite(qty)) ? qty : null,
    unit: (fd.get('unit') || '').trim(),
    category, deviceId, zoneId,
    expiry: (fd.get('expiry') || '') || null,
    note: (fd.get('note') || '').trim()
  };
  if(id){
    const it = state.ingredients.find(x => x.id === id);
    if(it) Object.assign(it, data);
    toast('✅ 已保存修改');
  } else {
    state.ingredients.push(Object.assign({ id: uid(), createdAt: Date.now() }, data));
    toast(`✅ 已添加 ${name}`);
  }
  save();
  closeModal();
  renderAll();
}

function submitRecipe(form){
  const fd = new FormData(form);
  const name = (fd.get('name') || '').trim();
  if(!name){ toast('请填写菜名'); return; }
  const tags = fd.getAll('tags');
  if(!tags.length){ toast('请至少选择一个标签'); return; }
  const rows = [...form.querySelectorAll('.ingform-row')];
  const ingredients = [];
  rows.forEach((row, idx) => {
    const iname = row.querySelector('[name=i_name]').value.trim();
    if(!iname) return;
    const amountRaw = row.querySelector('[name=i_amount]').value.trim();
    const optional = row.nextElementSibling && row.nextElementSibling.querySelector('[name=i_optional]')
      ? row.nextElementSibling.querySelector('[name=i_optional]').checked : false;
    ingredients.push({
      name: iname,
      amount: amountRaw === '' ? null : Number(amountRaw),
      unit: row.querySelector('[name=i_unit]').value.trim(),
      optional
    });
  });
  if(!ingredients.length){ toast('请至少填写一行食材'); return; }
  const steps = (fd.get('steps') || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
  const seasonings = (fd.get('seasonings') || '').split(/[,，、]+/).map(s => s.trim()).filter(Boolean);
  const id = fd.get('id');
  const data = {
    name, tags,
    baseServings: Math.max(1, Number(fd.get('baseServings')) || 2),
    time: Math.max(1, Number(fd.get('time')) || 15),
    difficulty: fd.get('difficulty') || '简单',
    ingredients, seasonings, steps
  };
  if(id){
    const idx = state.customRecipes.findIndex(r => r.id === id);
    if(idx >= 0){ Object.assign(state.customRecipes[idx], data); toast('✅ 菜谱已更新'); }
  } else {
    state.customRecipes.push(Object.assign({ id: uid(), custom: true }, data));
    toast(`✅ 「${name}」已加入菜谱库`);
  }
  save();
  closeModal();
  renderAll();
}

/* NAME_CATEGORY：由 COMMON_INGREDIENTS 生成，用于自动分类 */
const NAME_CATEGORY = {};
for(const cat in COMMON_INGREDIENTS){
  for(const n of COMMON_INGREDIENTS[cat]){
    NAME_CATEGORY[n] = cat;
    const canon = normalizeName(n);
    if(!NAME_CATEGORY[canon]) NAME_CATEGORY[canon] = cat;
  }
}

/* ---------------- 事件绑定 ---------------- */

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action]');
  if(!el) return;
  const a = el.dataset.action;
  const id = el.dataset.id;

  if(a === 'tab'){ e.preventDefault(); switchTab(el.dataset.tab); }
  else if(a === 'close-modal'){ closeModal(); }
  else if(a === 'servings'){
    const cur = state.settings.servings || 2;
    state.settings.servings = Math.min(12, Math.max(1, cur + Number(el.dataset.delta)));
    state.settings.lastAdjusted = 'servings'; // 最后调整的是人数：配餐按人数换算道数
    save();
    if(modalRecipeId) renderRecipeModal(modalRecipeId);
    renderAll(true);
  }
  else if(a === 'rec-filter'){
    const y = window.scrollY;
    recFilter = el.dataset.f;
    renderAll(true); // 切筛选不跳回顶部，停在当前位置
    window.scrollTo(0, y);
  }
  else if(a === 'compose-menu'){
    recomposeMenu();
    renderAll(true);
  }
  else if(a === 'clear-menu'){ state.todayMenu = []; save(); renderAll(); toast('菜单已清空'); }
  else if(a === 'toggle-menu'){ toggleTodayMenu(id); if(modalRecipeId) renderRecipeModal(modalRecipeId); renderAll(true); }
  else if(a === 'remove-menu'){
    state.todayMenu = (state.todayMenu || []).filter(m => m.id !== id);
    save(); renderAll(); toast('已从菜单移除');
  }
  else if(a === 'menu-lock'){
    const m = (state.todayMenu || []).find(x => x.id === id);
    if(m){ m.locked = !m.locked; save(); renderAll(true); }
  }
  else if(a === 'switch-mode'){ openModeModal(); }
  else if(a === 'set-mode'){
    state.settings.composeMode = el.dataset.mode;
    save(); closeModal(); renderAll(true);
    toast(`🔀 已选择「${{ smart:'智能配餐', random:'随机配餐', veg:'今日吃素', meat:'今日吃肉' }[el.dataset.mode]}」模式`);
  }
  else if(a === 'toggle-consider-stock'){
    state.settings.vegMeatConsiderStock = !(state.settings.vegMeatConsiderStock !== false);
    save(); renderAll(true);
    toast(state.settings.vegMeatConsiderStock ? '🥕 将优先搭配你现有食材能做的菜' : '🎲 将不看库存随机选菜');
  }
  else if(a === 'dish-count'){
    const base = getEffectiveDishCount(); // 先按当前显示值取基准（此时 lastAdjusted 可能还是人数）
    state.settings.lastAdjusted = 'dishCount';
    state.settings.dishCount = Math.min(16, Math.max(1, base + Number(el.dataset.delta)));
    save(); renderAll(true);
  }
  else if(a === 'open-recipe'){ renderRecipeModal(id); }
  else if(a === 'fav-toggle'){
    const i = state.favorites.indexOf(id);
    if(i >= 0) state.favorites.splice(i, 1);
    else state.favorites.push(id);
    save();
    if(modalRecipeId) renderRecipeModal(modalRecipeId);
    renderAll();
  }
  else if(a === 'copy-missing'){ copyMissing(id); }
  else if(a === 'deduct'){ doDeduct(id); }
  else if(a === 'add-ingredient'){ openIngredientForm(); }
  else if(a === 'edit-ingredient'){ openIngredientForm(id); }
  else if(a === 'del-ingredient'){
    const it = state.ingredients.find(x => x.id === id);
    if(!it) return;
    const ok = await confirmModal({ title: '删除食材', html: `确定删除「<b>${esc(it.name)}</b>」吗？`, okText: '删除', danger: true });
    if(!ok) return;
    state.ingredients = state.ingredients.filter(x => x.id !== id);
    save(); renderAll(); toast('🗑 已删除');
    if(zoneModal) openZoneItemsModal(zoneModal.deviceId, zoneModal.zoneId);
  }
  else if(a === 'qty-adj'){
    qtyAdjust(id, Number(el.dataset.delta));
    if(zoneModal) openZoneItemsModal(zoneModal.deviceId, zoneModal.zoneId);
  }
  else if(a === 'qty-edit'){ openQtyModal(id); }
  else if(a === 'submit-qty'){ submitQty(id); }
  else if(a === 'clear-pantry-filters'){
    pantrySearch = ''; pantryDevice = 'all'; pantryZone = 'all'; pantryCat = 'all';
    renderAll();
  }
  else if(a === 'pantry-cat'){ pantryCat = el.dataset.c; renderAll(); }
  else if(a === 'add-device'){ openDeviceForm(); }
  else if(a === 'edit-device'){ openDeviceForm(id); }
  else if(a === 'del-device'){
    const dev = deviceById(id);
    if(!dev) return;
    const n = state.ingredients.filter(it => it.deviceId === id).length;
    const ok = await confirmModal({
      title: `删除「${dev.name}」`,
      html: n ? `里面有 <b>${n}</b> 种食材，删除后它们会变成「未指定位置」。确定删除吗？` : '确定删除吗？',
      okText: '删除', danger: true
    });
    if(!ok) return;
    state.devices = state.devices.filter(d => d.id !== id);
    save(); renderAll(); toast('🗑 已删除');
  }
  else if(a === 'edit-zone'){ openZoneEditForm(el.dataset.device, id); }
  else if(a === 'del-zone'){ openZoneDeleteModal(el.dataset.device, id); }
  else if(a === 'submit-del-zone'){
    const deviceId = el.dataset.device, zoneId = el.dataset.zone;
    const dev = deviceById(deviceId);
    const f = dev ? findZoneInDevice(dev, zoneId) : null;
    if(!dev || !f) return;
    const ids = new Set([f.zone.id, ...(f.zone.children || []).map(c => c.id)]);
    const alsoDeleteItems = !!document.getElementById('delZoneItems')?.checked;
    if(alsoDeleteItems){
      const before = state.ingredients.length;
      state.ingredients = state.ingredients.filter(it => !(it.deviceId === deviceId && ids.has(it.zoneId)));
      toast(`🗑 已删除，${before - state.ingredients.length} 种食材一并删除`);
    } else {
      // 保留食材：位置改为未分区
      for(const it of state.ingredients){
        if(it.deviceId === deviceId && ids.has(it.zoneId)) it.zoneId = null;
      }
      toast('🗑 已删除，食材已保留到「未分区」');
    }
    if(f.isRoom){
      dev.zones = dev.zones.filter(z => z.id !== zoneId);
    } else {
      f.room.children = (f.room.children || []).filter(c => c.id !== zoneId);
    }
    save(); closeModal(); renderAll();
  }
  else if(a === 'open-fridge-modal'){ openFridgeModal(); }
  else if(a === 'close-fridge-modal'){ fridgeModalOpen = false; fridgeModalVisible = false; closeModal(); }
  else if(a === 'device-menu'){ openDeviceMenu(id); }
  else if(a === 'open-ai-chat'){ AIChat.open(); }
  else if(a === 'save-ai-settings'){
    state.settings.aiApiKey = document.getElementById('aiApiKey').value.trim();
    state.settings.aiModel = document.getElementById('aiModel').value;
    save(); renderAll();
    toast(state.settings.aiApiKey ? '🤖 AI 设置已保存，大模型理解已开启' : '已保存（未填 Key，使用离线解析）');
  }
  else if(a === 'add-device-zone'){ openZoneAddForm(id); }
  else if(a === 'add-layer'){ openLayerAddForm(el.dataset.device, el.dataset.room); }
  else if(a === 'submit-layer-add'){ submitLayerAddFromForm(document.querySelector('[data-form="layer-add"]')); }
  else if(a === 'view-zone'){ openZoneItemsModal(el.dataset.device, el.dataset.zone); }
  else if(a === 'close-zone-modal'){ zoneModal = null; zoneModalVisible = false; closeModal(); }
  else if(a === 'add-ingredient-zone'){ openIngredientForm(null, { deviceId: el.dataset.device, zoneId: el.dataset.zone }); }
  else if(a === 'goto-zone-pantry'){
    zoneModal = null; zoneModalVisible = false; closeModal();
    pantryDevice = el.dataset.device; pantryZone = el.dataset.zone; pantryCat = 'all'; pantrySearch = '';
    switchTab('pantry');
  }
  else if(a === 'open-recipe-form'){ openRecipeForm(); }
  else if(a === 'edit-recipe'){ openRecipeForm(id); }
  else if(a === 'del-recipe'){
    const r = recipeById(id);
    const ok = await confirmModal({ title: '删除菜谱', html: `确定删除自己的菜谱「<b>${esc(r.name)}</b>」吗？`, okText: '删除', danger: true });
    if(!ok) return;
    state.customRecipes = state.customRecipes.filter(x => x.id !== id);
    state.favorites = state.favorites.filter(f => f !== id);
    save(); closeModal(); renderAll(); toast('🗑 菜谱已删除');
  }
  else if(a === 'add-ing-row'){
    const box = document.getElementById('ingRows');
    if(!box) return;
    if(box.querySelectorAll('.ingform-row').length >= 15){ toast('食材行数够多啦'); return; }
    box.insertAdjacentHTML('beforeend', ingFormRow({}));
  }
  else if(a === 'rm-ing-row'){
    const row = el.closest('.ingform-row');
    const opt = row.nextElementSibling;
    if(opt && opt.querySelector && opt.querySelector('[name=i_optional]')) opt.remove();
    row.remove();
  }
  else if(a === 'submit-ingredient'){ submitIngredient(document.getElementById('ingredientForm')); }
  else if(a === 'submit-device'){
    const form = document.querySelector('[data-form="device"]');
    const name = form.querySelector('[name=name]').value.trim();
    const fid = form.querySelector('[name=id]').value;
    if(!name){ toast('请填写名称'); return; }
    if(fid){
      const dev = deviceById(fid);
      if(dev) dev.name = name;
      toast('✅ 已保存');
    } else {
      // 新设备预建常用分区：冰箱给"冷藏室+冷冻室"，其他（如冰柜）给"冷冻室"
      const zones = name.includes('冰柜')
        ? [{ id: uid(), name: '冷冻室', children: [] }]
        : [{ id: uid(), name: '冷藏室', children: [] }, { id: uid(), name: '冷冻室', children: [] }];
      state.devices.push({ id: uid(), name, zones });
      toast(`✅ 已添加「${name}」，分区可随时增删排序`);
    }
    save(); closeModal(); renderAll();
  }
  else if(a === 'submit-zone-add'){ submitZoneAddFromForm(document.querySelector('[data-form="zone-add"]')); }
  else if(a === 'submit-zone-edit'){
    const form = document.querySelector('[data-form="zone-edit"]');
    const dev = deviceById(form.querySelector('[name=deviceId]').value);
    const f = dev ? findZoneInDevice(dev, form.querySelector('[name=zoneId]').value) : null;
    const name = form.querySelector('[name=name]').value.trim();
    if(f && name){ f.zone.name = name; save(); closeModal(); renderAll(); toast('✅ 已改名'); }
  }
  else if(a === 'submit-recipe'){ submitRecipe(document.getElementById('recipeForm')); }
  else if(a === 'export-data'){ exportData(); }
  else if(a === 'toggle-seasonings'){
    state.settings.seasoningsMatter = !state.settings.seasoningsMatter;
    save();
    renderAll();
    toast(state.settings.seasoningsMatter ? '🧂 调料已参与匹配，记得把家里有的调料加进「食材」' : '🧂 调料已恢复默认常备，不参与匹配');
  }
  else if(a === 'open-batch-import'){ openBatchImport(); }
  else if(a === 'do-batch-import'){ doBatchImport(); }
  else if(a === 'clear-all'){
    const ok1 = await confirmModal({ title: '清空所有数据', html: '这将删除全部食材、分区和自定义菜谱，<b>不可恢复</b>。确定吗？', okText: '继续', danger: true });
    if(!ok1) return;
    const ok2 = await confirmModal({ title: '再次确认', html: '真的要清空吗？建议先「导出备份」。', okText: '确认清空', danger: true });
    if(!ok2) return;
    try { localStorage.removeItem(STORE_KEY); } catch(e){}
    state = defaultState();
    state.welcomed = true;
    save();
    renderAll();
    toast('🧹 已清空');
  }
  else if(a === 'welcome-done'){
    state.welcomed = true;
    save();
    closeModal();
  }
});

/* 下拉框联动 */
document.addEventListener('change', e => {
  const inp = e.target;
  const c = inp.dataset ? inp.dataset.change : null;
  const el = inp;
  // 单位框提交时同步换算基准
  if(inp.name === 'unit') inp.dataset.wprev = inp.value.trim();
  if(c === 'pantry-device'){ pantryDevice = el.value; pantryZone = 'all'; renderAll(); }
  else if(c === 'form-device'){
    const form = el.closest('form');
    fillZoneSelect(form, el.value, '');
  }
  else if(c === 'import-file'){
    if(el.files && el.files[0]) importData(el.files[0]);
    el.value = '';
  }
});

/* 输入框即时筛选 */
let searchTimer = null;
document.addEventListener('input', e => {
  const el = e.target;
  const c = el.dataset ? el.dataset.input : null;
  if(c === 'pantry-search'){
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      pantrySearch = el.value;
      const box = document.getElementById('pantry-results');
      if(box) box.innerHTML = pantryResultsHtml();
    }, 180);
  }
  else if(c === 'recipe-search'){
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      recipeSearch = el.value;
      const box = document.getElementById('recipe-results');
      if(box) box.innerHTML = recipeResultsHtml();
    }, 180);
  }
  // 单位输入框：先按 克/斤/公斤/千克 切换换算数量，再刷新联想下拉（顺序不能反，否则换算基准被覆盖）
  if(el.name === 'unit') convertWeightUnit(el);
  if(el.dataset && el.dataset.suggest) showSuggest(el);
});

/* 内联表单（新增分区） */
document.addEventListener('submit', e => {
  const form = e.target;
  if(form.matches('[data-form="zone-add"]')){
    e.preventDefault();
    submitZoneAddFromForm(form);
  }
  else if(form.matches('[data-form="layer-add"]')){
    e.preventDefault();
    submitLayerAddFromForm(form);
  }
  else if(form.matches('[data-form="ingredient"]')){
    e.preventDefault();
    submitIngredient(form);
  }
  else if(form.matches('[data-form="recipe"]')){
    e.preventDefault();
    submitRecipe(form);
  }
  else if(form.matches('[data-form="device"]')){
    e.preventDefault();
  }
  else if(form.matches('[data-form="zone-edit"]')){
    e.preventDefault();
  }
  else if(form.matches('[data-form="qty"]')){
    e.preventDefault();
    submitQty(form.dataset.id); // 数量弹窗里按回车直接保存
  }
});

/* 旧数据自动修复：名称去首尾空格、补齐缺失的分类（如旧版本添加的"猪肉/鸡肉"） */
function fixLegacyData(){
  let changed = false;
  for(const it of state.ingredients){
    const name = String(it.name || '').trim();
    if(name !== it.name){ it.name = name; changed = true; }
    if(!it.category || it.category === '其他'){
      const cat = NAME_CATEGORY[normalizeName(name)];
      if(cat && cat !== '其他'){ it.category = cat; changed = true; }
    }
  }
  if(changed) save();
}

/* 一次性迁移：旧版默认的多个分区（冷藏-上层/中层/下层、左侧门、右侧门）合并为"冷藏室"，食材位置跟着迁过去 */
function migrateZonesToTwo(){
  if(state.settings.zonesMigrated) return;
  let changed = false;
  const oldCold = ['冷藏-上层','冷藏-中层','冷藏-下层','左侧门','右侧门'];
  for(const dev of state.devices){
    if(dev.name !== '冰箱') continue;
    const zones = dev.zones || [];
    if(!zones.some(z => oldCold.includes(z.name))) continue;
    const leng = zones.find(z => z.name === '冷藏室');
    const fro = zones.find(z => z.name === '冷冻室');
    const lengId = leng ? leng.id : uid();
    const froId = fro ? fro.id : uid();
    const map = {};
    for(const n of oldCold) map[n] = lengId;
    map['冷冻室'] = froId;
    for(const it of state.ingredients){
      if(it.deviceId !== dev.id) continue;
      const z = zones.find(zz => zz.id === it.zoneId);
      if(z && map[z.name]) it.zoneId = map[z.name];
    }
    dev.zones = [{ id: lengId, name: '冷藏室', children: [] }, { id: froId, name: '冷冻室', children: [] }];
    changed = true;
  }
  state.settings.zonesMigrated = true;
  if(changed) save();
}

/* 一次性迁移：升级为两级结构（室 → 分层）。顶层里除"冷藏室/冷冻室"外的分区（用户手动建的"第一层"等）并入冷藏室作为分层 */
function migrateToRoomHierarchy(){
  if(state.settings.roomsHierarchy) return;
  let changed = false;
  for(const dev of state.devices){
    const rooms = dev.zones || [];
    rooms.forEach(z => { if(!Array.isArray(z.children)) z.children = []; });
    const main = rooms.find(z => z.name === '冷藏室') || rooms.find(z => z.name === '冷冻室');
    if(!main) continue;
    for(const z of rooms.slice()){
      if(z.name === '冷藏室' || z.name === '冷冻室') continue;
      main.children.push({ id: z.id, name: z.name, children: [] });
      rooms.splice(rooms.indexOf(z), 1);
      changed = true;
    }
  }
  state.settings.roomsHierarchy = true;
  if(changed) save();
}

/* ---------------- 启动 ---------------- */

fixLegacyData();
migrateZonesToTwo();
migrateToRoomHierarchy();
renderAll();
if(!state.welcomed){
  openModal(`
    <div class="modal-head"><h2>👋 欢迎使用食材管家</h2></div>
    <div class="modal-body" style="font-size:14.5px; line-height:2.1;">
      三步开始（就 1 分钟）：<br>
      <b>① 🥕 去「食材」页</b>——把现有的食材加进来，选好放在哪；点「🧊 我的冰箱」可建冰箱分区<br>
      <b>② 🍳 回到「推荐」页</b>——选好吃饭人数和菜品数量，看看今天吃啥<br>
      <b>③ 📖 去「菜谱」页</b>——想吃的菜点"＋ 今日菜单"，自己搭配一桌
    </div>
    <div class="modal-foot">
      <button class="btn btn-primary" data-action="welcome-done">开始使用</button>
    </div>`);
}
