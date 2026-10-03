/* ==========================================================
   食材管家 · 推荐算法
   - normalizeName：食材名归一（别名→标准名），番茄和西红柿能互相匹配
   - buildPantry：把库存整理成按名字聚合的索引
   - analyzeRecipe：单道菜与库存的匹配分析（有多少、缺什么、量够不够）
   - rankRecipes：全部菜谱按推荐度排序
   - composeMenu：按人数自动搭配"几荤几素一汤"
   ========================================================== */

function normalizeName(name){
  const n = String(name || '').trim();
  return SYNONYMS[n] || n;
}

function daysUntil(dateStr){
  if(!dateStr) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  const d = new Date(dateStr + 'T00:00:00');
  if(isNaN(d)) return null;
  return Math.round((d - today) / 86400000);
}

function isExpiringSoon(item){
  const d = daysUntil(item.expiry);
  return d !== null && d <= 2;
}

function roundQty(n){
  if(typeof n !== 'number' || !isFinite(n)) return n;
  return Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 10) / 10;
}

function fmtQty(n){
  if(n === null || n === undefined || n === '') return '适量';
  const num = Number(n);
  if(!isFinite(num)) return '适量';
  return String(roundQty(num));
}

/* 按人份换算用量：菜谱基准 baseServings 人 → 实际 servings 人 */
function scaledAmount(recipe, ing, servings){
  const base = recipe.baseServings || 2;
  return roundQty((ing.amount || 0) * servings / base);
}

/* 把库存按归一后的名字聚合。qty 为 null 表示"有，但没记数量" */
function buildPantry(items){
  const map = {};
  for(const it of items){
    const key = normalizeName(it.name);
    if(!key) continue;
    if(!map[key]){
      map[key] = { key, label: it.name, totalQty: 0, qtyKnown: true, units: new Set(), items: [], expiring: false };
    }
    const p = map[key];
    p.items.push(it);
    if(it.unit) p.units.add(it.unit);
    if(typeof it.qty === 'number') p.totalQty += it.qty;
    else p.qtyKnown = false;
    if(isExpiringSoon(it)) p.expiring = true;
  }
  for(const k in map){
    const p = map[k];
    if(p.units.size > 1) p.qtyKnown = false;
    p.unit = [...p.units][0] || '';
  }
  return map;
}

/* 单道菜的匹配分析 */
function analyzeRecipe(recipe, pantry, servings, ctx){
  ctx = ctx || {};
  /* 必需清单 = 必需食材（+ 调料，若设置里开启"调料参与匹配"） */
  const required = [];
  const seenReq = new Set();
  for(const ing of (recipe.ingredients || []).filter(i => !i.optional)){
    const k = normalizeName(ing.name);
    if(!k || seenReq.has(k)) continue;
    seenReq.add(k);
    required.push({ name: ing.name, amount: ing.amount, unit: ing.unit, optional: false, src: 'ing' });
  }
  if(ctx.seasoningsMatter){
    for(const s of (recipe.seasonings || [])){
      const k = normalizeName(s);
      if(!k || seenReq.has(k)) continue;
      seenReq.add(k);
      required.push({ name: s, amount: null, unit: '', optional: false, src: 'seasoning' });
    }
  }
  const optional = (recipe.ingredients || []).filter(i => i.optional);
  const missing = [], short = [], have = [];
  let expiring = false;

  for(const ing of required){
    const p = pantry[normalizeName(ing.name)];
    if(!p){ missing.push(ing); continue; }
    if(p.expiring) expiring = true;
    const need = (typeof ing.amount === 'number') ? scaledAmount(recipe, ing, servings) : null;
    const unitOk = p.unit && ing.unit && p.unit === ing.unit;
    if(need !== null && p.qtyKnown && unitOk && p.totalQty < need - 0.001){
      short.push({ ing, need, have: p.totalQty, userLabel: p.label });
    } else {
      have.push({ ing, p });
    }
  }
  for(const ing of optional){
    const p = pantry[normalizeName(ing.name)];
    if(p && p.expiring) expiring = true;
  }

  const totalReq = required.length;
  const coverage = totalReq ? (totalReq - missing.length) / totalReq : 1;
  const enough = missing.length === 0 && short.length === 0;
  const optionalHad = optional.filter(ing => pantry[normalizeName(ing.name)]).length;

  let score = coverage * 100
    - short.length * 6
    + optionalHad * 3
    + (expiring ? 8 : 0)
    + (ctx.favorites && ctx.favorites.has(recipe.id) ? 6 : 0);

  return { missing, short, have, optionalHad, coverage, enough, expiring, score };
}

/* 全部菜谱排序 */
function rankRecipes(pantry, servings, ctx){
  return ALL_RECIPES()
    .map(r => ({ recipe: r, a: analyzeRecipe(r, pantry, servings, ctx) }))
    .sort((x, y) => y.a.score - x.a.score
      || y.a.coverage - x.a.coverage
      || (x.recipe.time || 0) - (y.recipe.time || 0));
}

/* 菜谱的"主料"（第一个必需食材），配餐时避免两道菜用同一种主料 */
function primaryOf(recipe){
  const req = (recipe.ingredients || []).filter(i => !i.optional);
  return req.length ? normalizeName(req[0].name) : recipe.name;
}

/* 按用户选定的菜品总数搭配一餐：荤素对半，汤羹和主食按比例点缀（智能模式，按库存匹配度优先） */
function composeMenu(pantry, count, servings, ctx, lockedIds){
  lockedIds = lockedIds || new Set();
  count = Math.max(1, Math.min(16, count || 3));
  const soup = count >= 3 ? Math.min(2, Math.max(1, Math.round(count * 0.15))) : 0;
  const staple = count >= 8 ? Math.max(1, Math.round(count * 0.1)) : 0;
  const rest = count - soup - staple;
  const meat = Math.ceil(rest / 2);
  const veg = rest - meat;
  const plan = [['荤菜', meat], ['素菜', veg], ['汤羹', soup], ['主食', staple]].filter(p => p[1] > 0);

  const usedPrim = new Set();
  const dishes = [];
  const inDishes = r => dishes.some(d => d.id === r.id);

  for(const [tag, cnt] of plan){
    const pool = ALL_RECIPES()
      .filter(r => (r.tags || []).includes(tag) && !inDishes(r) && !lockedIds.has(r.id))
      .map(r => ({ recipe: r, a: analyzeRecipe(r, pantry, servings, ctx) }))
      .sort((x, y) => y.a.score - x.a.score || y.a.coverage - x.a.coverage);

    const chosen = [];
    for(const c of pool){
      if(chosen.length >= cnt) break;
      const prim = primaryOf(c.recipe);
      if(chosen.some(x => primaryOf(x.recipe) === prim)) continue;
      if(usedPrim.has(prim) && pool.some(p => !usedPrim.has(primaryOf(p.recipe)) && !chosen.includes(p))) continue;
      chosen.push(c);
    }
    for(const c of pool){
      if(chosen.length >= cnt) break;
      if(!chosen.includes(c)) chosen.push(c);
    }
    chosen.forEach(c => { dishes.push(c.recipe); usedPrim.add(primaryOf(c.recipe)); });
  }
  return dishes;
}

/* 随机配餐：不看库存，从全部菜谱里随机挑 */
function composeRandom(count, lockedIds){
  lockedIds = lockedIds || new Set();
  const pool = ALL_RECIPES().filter(r => !lockedIds.has(r.id));
  return shuffleArr(pool).slice(0, Math.max(0, count));
}

/* 吃素/吃肉模式：以指定类型的菜为主，不够时用汤羹/主食补；
   considerStock 为 true 时按库存匹配度优先，false 时随机选 */
function composeByTag(pantry, count, servings, ctx, mainTag, considerStock, lockedIds){
  lockedIds = lockedIds || new Set();
  const all = ALL_RECIPES().filter(r => !lockedIds.has(r.id));
  const main = all.filter(r => (r.tags || []).includes(mainTag));
  const filler = all.filter(r => (r.tags || []).includes('汤羹') || (r.tags || []).includes('主食'));
  const order = pool => {
    const arr = pool.slice();
    if(considerStock){
      arr.sort((a, b) => analyzeRecipe(b, pantry, servings, ctx).score - analyzeRecipe(a, pantry, servings, ctx).score);
    } else {
      for(let i = arr.length - 1; i > 0; i--){
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
    }
    return arr;
  };
  const chosen = [];
  const used = new Set();
  const take = pool => {
    for(const r of order(pool)){
      if(chosen.length >= count) break;
      if(used.has(r.id)) continue;
      chosen.push(r);
      used.add(r.id);
    }
  };
  take(main);
  if(chosen.length < count) take(filler);
  if(chosen.length < count) take(all.filter(r => !used.has(r.id)));
  return chosen;
}

function shuffleArr(arr){
  const a = arr.slice();
  for(let i = a.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* 汇总一餐组合还缺什么（跨菜去重） */
function menuGaps(dishes){
  const out = [], seen = new Set();
  for(const d of dishes){
    for(const m of d.a.missing){
      const k = '缺' + normalizeName(m.name);
      if(!seen.has(k)){ seen.add(k); out.push({ type:'缺', label: m.name }); }
    }
    for(const s of d.a.short){
      const k = '短' + normalizeName(s.ing.name);
      if(!seen.has(k)){
        seen.add(k);
        out.push({ type:'量不足', label: s.ing.name,
          detail: `需${fmtQty(s.need)}${s.ing.unit || ''}，现有${fmtQty(s.have)}${s.ing.unit || ''}` });
      }
    }
  }
  return out;
}
