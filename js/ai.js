/* ==========================================================
   食材管家 · AI 助手（双引擎）
   1) 本地意图解析（优先，离线可用）：覆盖 15+ 种日常指令
   2) 大模型解析（可选）：仅当本地解析无法识别时才调用
   ========================================================== */

const AI_MODE_LABELS = { smart:'智能配餐', random:'随机配餐', veg:'今日吃素', meat:'今日吃肉' };
const AI_UNITS = ['公斤','千克','毫升','大勺','小勺','斤','克','个','根','颗','瓣','片','把','勺','包','盒','袋','瓶','块','条','只','朵','罐','碗','杯'];
const AI_NUM_SRC = '([0-9]+(?:\\.[0-9]+)?|半|[一二两三四五六七八九十百]+)(半)?';
const aiLog = [];

/* ---------------- 工具函数 ---------------- */

function parseCnNumber(str){
  str = String(str || '').trim();
  if(!str) return null;
  if(/^\d+(\.\d+)?$/.test(str)) return parseFloat(str);
  if(str === '半') return 0.5;
  const N = { 零:0, 一:1, 二:2, 两:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9 };
  let total = 0, temp = 0;
  for(const ch of str){
    if(ch === '十'){ total = (temp || 1) * 10; temp = 0; }
    else if(ch === '百'){ total = (temp || 1) * 100; temp = 0; }
    else if(N[ch] !== undefined){ temp = temp >= 10 ? temp + N[ch] : N[ch]; }
    else return null;
  }
  return total + temp;
}

function cnToNum(s){
  return String(s || '').replace(/一/g,'1').replace(/二/g,'2').replace(/两/g,'2')
    .replace(/三/g,'3').replace(/四/g,'4').replace(/五/g,'5').replace(/六/g,'6')
    .replace(/七/g,'7').replace(/八/g,'8').replace(/九/g,'9').replace(/十/g,'10');
}

function shuffleArr(arr){
  const a = arr.slice();
  for(let i = a.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ---------------- 位置匹配 ---------------- */

function aiMatchLocation(text){
  if(!state.devices.length) return null;
  const dev = state.devices.find(d => text.includes(d.name))
           || state.devices.find(d => d.name.includes('冰箱'))
           || state.devices[0];
  const rooms = dev.zones || [];
  let room = rooms.find(r => text.includes(r.name))
          || rooms.find(r => r.name.length > 2 && text.includes(r.name.replace(/室$/, '')));
  if(!room && /冷冻|冰冻/.test(text)) room = rooms.find(r => r.name.includes('冷冻'));
  if(!room && /冷藏|保鲜/.test(text)) room = rooms.find(r => r.name.includes('冷藏'));
  const out = { deviceId: dev.id, zoneId: null, label: dev.name + '（未分区）', created: '' };
  if(room){
    out.zoneId = room.id;
    out.label = dev.name + '·' + room.name;
    const lm = text.match(/第\s*([0-9一二两三四五六七八九十]+)\s*层/);
    let want = null;
    if(lm){
      const n = parseCnNumber(lm[1]);
      want = '第' + (n !== null ? n : lm[1]) + '层';
    } else if(/最?上层/.test(text)) want = '上层';
    else if(/最?下层/.test(text)) want = '下层';
    if(want){
      room.children = room.children || [];
      let layer = room.children.find(c => cnToNum(c.name.replace(/\s/g, '')) === cnToNum(want) || c.name.includes(want));
      if(!layer){
        layer = { id: uid(), name: want, children: [] };
        room.children.push(layer);
        out.created = '（已自动创建分层「' + want + '」）';
      }
      out.zoneId = layer.id;
      out.label = dev.name + '·' + room.name + '·' + layer.name;
    }
  }
  return out;
}

/* ---------------- 食材条目抽取 ---------------- */

function aiExtractItems(text){
  const items = [];
  const unitRe = '(' + AI_UNITS.join('|') + ')';
  const re = new RegExp(AI_NUM_SRC + unitRe, 'g');
  for(const seg of text.split(/[，,。；;！!？?\s]+|还有|再买|又买|以及|另外/g)){
    const s = seg.trim();
    if(!s) continue;
    const matches = [...s.matchAll(re)];
    for(let i = 0; i < matches.length; i++){
      const m = matches[i];
      const qty = parseCnNumber(m[1]) + (m[2] ? 0.5 : 0);
      if(!qty || qty <= 0) continue;
      const unit = m[3] || '个';
      const start = m.index + m[0].length;
      const end = i + 1 < matches.length ? matches[i + 1].index : s.length;
      let name = s.slice(start, end)
        .replace(/(放在?了?|放进?了?|放到|放|添加?(到|进|入)?|塞进?了?|装进?了?).*$/, '')
        .replace(/^(?:和|与|及|再|还|买了?|要了?|来了?|来点)/, '')
        .trim();
      if(!name) continue;
      items.push({ name, qty, unit, seg: s, location: s });
    }
  }
  return items;
}

/* ---------------- 菜谱模糊匹配 ---------------- */

function findBestRecipe(q){
  q = String(q || '').trim();
  if(!q) return null;
  const all = ALL_RECIPES();
  let r = all.find(x => x.name === q);
  if(r) return { recipe: r, matched: '名称完全一致' };
  r = all.find(x => x.name.includes(q) || q.includes(x.name));
  if(r) return { recipe: r, matched: '名称相近' };
  let best = null, bestScore = -1;
  for(const x of all){
    const nameSet = new Set(x.name.split(''));
    let score = 0;
    for(const ch of q) if(nameSet.has(ch)) score++;
    const ingHits = (x.ingredients || []).filter(i => q.includes(normalizeName(i.name))).length;
    const total = score + ingHits * 1.5;
    if(total > bestScore){ bestScore = total; best = x; }
  }
  return bestScore >= 2 ? { recipe: best, matched: '按食材猜的' } : null;
}

/* ================= 本地意图解析（优先） ================= */
/* 按特定→通用排序，越靠前越精确 */

function aiLocalParse(text){
  const t = text.trim();
  if(!t) return null;

  /* --- 参数提取 --- */
  const params = {};
  const servM = t.match(/([0-9]+|[一二两三四五六七八九十]+)\s*个?\s*[人口]/);
  if(servM){ const n = parseCnNumber(servM[1]); if(n && n >= 1 && n <= 12) params.servings = n; }
  const dcM = t.match(/([0-9]+|[一二两三四五六七八九十]+)\s*[个道]\s*(菜|道)/);
  if(dcM){ const n = parseCnNumber(dcM[1]); if(n && n >= 1 && n <= 16) params.dishCount = n; }
  if(/肉菜|吃肉|都做肉|全是荤|来点荤|硬菜/.test(t)) params.mode = 'meat';
  else if(/素菜|吃素|都做素|全是素|来点素|清淡|素食/.test(t)) params.mode = 'veg';
  else if(/随机/.test(t)) params.mode = 'random';
  const hasParams = Object.keys(params).length > 0;

  /* --- 1. 换搭配（保持道数重新配，不清空） --- */
  if(/换一下|换几个|换一批|换点别的|重新配|再来一套|换一套|不想吃这些|吃腻了|换个花样/.test(t)){
    return { reply: '', actions: [Object.assign({ type: 'composeMenu' }, params)] };
  }

  /* --- 2. 去掉某道菜 --- */
  const rmMenuM = t.match(/(?:去掉|不要|移除|删掉|除去)\s*([^，。；;？?!！\s]{2,8})/);
  if(rmMenuM){
    const name = rmMenuM[1].replace(/^(?:菜|这道|那个)/, '').trim();
    if(name && (state.todayMenu || []).some(m => { const r = recipeById(m.id); return r && r.name.includes(name); })){
      return { reply: '', actions: [{ type: 'removeFromMenu', name }] };
    }
  }

  /* --- 3. 锁定/解锁 --- */
  const lockM = t.match(/锁定\s*([^，。；;？?!！\s]{2,8})/);
  if(lockM) return { reply: '', actions: [{ type: 'lockDish', name: lockM[1].trim(), locked: true }] };
  const unlockM = t.match(/解锁\s*([^，。；;？?!！\s]{2,8})/);
  if(unlockM) return { reply: '', actions: [{ type: 'lockDish', name: unlockM[1].trim(), locked: false }] };

  /* --- 4. X怎么做 / X需要什么 --- */
  const howM = t.match(/([^，。；;？?!！\s]{2,10})(?:怎么做|的做法|需要(?:什么|哪些(?:食材)?)|要什么(?:食材)?)/);
  if(howM){
    const name = howM[1].replace(/^(?:帮我看看?|告诉me|那个|这个)/, '').trim();
    if(name && name.length >= 2) return { reply: '', actions: [{ type: 'checkDish', name }] };
  }

  /* --- 5. 快过期 --- */
  if(/快过期|要过期|快到期|保质期.*快|过期.*食材/.test(t) && /什么|哪些|有|列出|看看/.test(t)){
    return { reply: '', actions: [{ type: 'listExpiring' }] };
  }

  /* --- 6. 今日菜单里有什么 --- */
  if(/(?:今日|现在|当前)?(?:菜单|搭配).*(?:什么|哪些|看看|是什么)/.test(t) || /(?:看看|打开|显示)(?:今日)?菜单/.test(t)){
    return { reply: '', actions: [{ type: 'listMenu' }] };
  }

  /* --- 7. 想吃某菜 --- */
  const dishM = t.match(/(?:想吃|想做|想来个?|来个?|做一道|整个|尝尝)([^，。；;？?!！\s]+)/);
  if(dishM){
    const name = dishM[1].replace(/还要?.*$/, '').trim();
    if(name && name.length >= 2) return { reply: '', actions: [{ type: 'checkDish', name }] };
  }

  /* --- 8. 食材用完/删除 --- */
  const usedM = t.match(/([^，。；;？?!！\s]{1,6}?)(?:吃完了|用完了|没有了|没了$|删掉|删除)/);
  if(usedM){
    const name = usedM[1].replace(/^(?:家里|冰箱|冰柜|那个|这个)/, '').trim();
    if(name && state.ingredients.some(i => i.name.includes(name))){
      return { reply: '', actions: [{ type: 'removeIngredient', name }] };
    }
  }

  /* --- 9. 食材在哪 --- */
  const locM = t.match(/([^，。；;？?!！\s]{1,8}?)(?:在哪|放在?哪|在哪个位置|在哪个格子|放在了哪里|放在哪里)/);
  if(locM){
    const name = locM[1].replace(/^(?:家里|冰箱|冰柜|请问)/, '').trim();
    if(name && state.ingredients.some(i => i.name.includes(name))){
      return { reply: '', actions: [{ type: 'findIngredientLoc', name }] };
    }
  }

  /* --- 10. X还剩多少 / X有多少 --- */
  const qtyM = t.match(/([^，。；;？?!！\s]{1,6}?)(?:还剩多少|还有多少|还剩|剩多少|有多少)/);
  if(qtyM){
    const name = qtyM[1].replace(/^(?:家里|冰箱|冰柜)/, '').trim();
    if(name && name.length >= 1 && state.ingredients.some(i => i.name.includes(name))){
      return { reply: '', actions: [{ type: 'checkQty', name }] };
    }
  }

  /* --- 11. 通用配菜（含参数） --- */
  if(/不知道.*(吃|做)|吃什么|做什么吃|来什么|配(一)?(桌|菜)|搭配|推荐.*菜/.test(t)){
    return { reply: '', actions: [Object.assign({ type: 'composeMenu' }, params)] };
  }
  if(hasParams && (params.dishCount || params.mode) && /吃|做|来|配|饭|菜/.test(t)){
    return { reply: '', actions: [Object.assign({ type: 'composeMenu' }, params)] };
  }

  /* --- 12. 添加食材 --- */
  if(/买了?|放入|放进|放到|塞进|添加|装进|囤/.test(t)){
    const items = aiExtractItems(t);
    if(items.length) return { reply: '', actions: [{ type: 'addIngredients', items }] };
  }

  /* --- 13. 查库存 --- */
  if(/有什么|有哪些|库存|都有啥|家里有/.test(t)){
    return { reply: '', actions: [{ type: 'listStock' }] };
  }

  /* --- 14. 清空菜单（仅明确说清空） --- */
  if(/清空菜单|清空今日|清掉菜单/.test(t)) return { reply: '', actions: [{ type: 'clearMenu' }] };

  return null;
}

/* ================= 大模型解析（本地不认识时兜底） ================= */

function aiStateSummary(){
  const zones = state.devices.map(d =>
    d.name + '：' + (d.zones || []).map(r => r.name + ((r.children || []).length ? '(' + r.children.map(c => c.name).join('/') + ')' : '')).join('、')
  ).join('；');
  const stock = state.ingredients.map(i =>
    i.name + (typeof i.qty === 'number' ? ' ' + fmtQty(i.qty) + (i.unit || '') : '') + '(' + locText(i) + ')'
  ).join('、') || '（空）';
  const menu = (state.todayMenu || []).map(m => { const r = recipeById(m.id); return r ? r.name : ''; }).filter(Boolean).join('、');
  return '设备与分区：' + zones + '\n现有食材：' + stock + '\n今日菜单：' + (menu || '（空）') + '\n菜谱库共 ' + ALL_RECIPES().length + ' 道菜。';
}

async function aiLLMParse(text){
  const key = (state.settings.aiApiKey || '').trim();
  if(!key) return null;
  const sys = [
    '你是家庭食材管理应用的助手。请把用户的话解析成 JSON 操作指令。',
    '当前应用状态：', aiStateSummary(),
    '',
    '⚠️ 重要规则：',
    '- 用户说"换一下/换几个/吃腻了" → 用 composeMenu（保持道数重新配），绝对不要用 clearMenu',
    '- 只有用户明确说"清空/清掉菜单"才用 clearMenu',
    '- 用户说"去掉/不要 某菜" → 用 removeFromMenu',
    '- 用户说"锁定 某菜" → 用 lockDish',
    '',
    '可用操作（actions 数组，可多个）：',
    '1) {"type":"addIngredients","items":[{"name":"食材名","qty":数字,"unit":"单位","location":"设备·室·分层 或 留空"}]}',
    '2) {"type":"composeMenu","servings":人数,"dishCount":道数,"mode":"meat|veg|random"} 自动配菜（参数可选）',
    '   mode: "meat"(肉菜为主) "veg"(素菜为主) "random"(随机)',
    '3) {"type":"checkDish","name":"菜名"} 检查能不能做、缺什么',
    '4) {"type":"removeFromMenu","name":"菜名"} 从今日菜单移除',
    '5) {"type":"lockDish","name":"菜名","locked":true/false} 锁定/解锁',
    '6) {"type":"listStock"} 报告现有食材',
    '7) {"type":"listMenu"} 报告今日菜单',
    '8) {"type":"listExpiring"} 报告快过期食材',
    '9) {"type":"removeIngredient","name":"食材名"} 删除食材记录',
    '10) {"type":"findIngredientLoc","name":"食材名"} 查食材放在哪',
    '11) {"type":"checkQty","name":"食材名"} 查食材剩余量',
    '12) {"type":"clearMenu"} 清空菜单（仅用户明确说清空时用）',
    '',
    '回复格式（只返回 JSON）：{"reply":"给用户的简短中文回复","actions":[...]}。单位只能用：' + COMMON_UNITS.join('、') + '。'
  ].join('\n');
  const body = JSON.stringify({
    model: state.settings.aiModel || 'glm-4-flash',
    messages: [{ role: 'system', content: sys }, { role: 'user', content: text }],
    temperature: 0.2
  });
  let lastErr = null;
  for(let attempt = 0; attempt < 3; attempt++){
    if(attempt > 0) await new Promise(r => setTimeout(r, attempt === 1 ? 1000 : 3000));
    try {
      const res = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body
      });
      if(res.status === 429){ lastErr = new Error('请求太频繁'); continue; }
      if(!res.ok) throw new Error('接口返回 ' + res.status);
      const data = await res.json();
      const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
      const m = content.replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
      if(!m) throw new Error('大模型没有返回有效 JSON');
      const parsed = JSON.parse(m[0]);
      if(!parsed || !Array.isArray(parsed.actions)) throw new Error('返回格式不对');
      return parsed;
    } catch(err){
      if(err.message === '请求太频繁'){ lastErr = err; continue; }
      throw err;
    }
  }
  throw new Error('请求太频繁（已重试 2 次），请等几秒再发');
}

/* ================= 操作执行器 ================= */

function executeAiActions(actions){
  let reply = '';
  const acts = [];
  for(const act of (actions || [])){
    if(act.type === 'addIngredients'){
      const added = [];
      for(const item of (act.items || [])){
        const name = String(item.name || '').trim();
        if(!name) continue;
        const loc = aiMatchLocation(String(item.location || '') + ' ' + name) || {};
        const qty = (typeof item.qty === 'number' && item.qty > 0) ? item.qty : null;
        state.ingredients.push({
          id: uid(), name, qty, unit: String(item.unit || '个').trim(),
          category: NAME_CATEGORY[normalizeName(name)] || '其他',
          deviceId: loc.deviceId || null, zoneId: loc.zoneId || null,
          expiry: null, note: ''
        });
        added.push(name + (qty ? ' ' + fmtQty(qty) + (item.unit || '') : '') + (loc.label ? ' → ' + loc.label + (loc.created || '') : ''));
      }
      if(added.length){
        reply += '✅ 已添加 ' + added.length + ' 样食材：\n' + added.map(a => '· ' + a).join('\n');
        acts.push({ label: '🥕 去食材页看看', act: 'goto-pantry' });
      }
    }
    else if(act.type === 'composeMenu'){
      if(act.servings && act.servings >= 1 && act.servings <= 12){
        state.settings.servings = Math.round(act.servings);
      }
      if(act.mode && ['smart','random','veg','meat'].includes(act.mode)){
        state.settings.composeMode = act.mode;
      }
      if(act.dishCount && act.dishCount >= 1 && act.dishCount <= 16){
        state.settings.dishCount = Math.round(act.dishCount);
        state.settings.lastAdjusted = 'dishCount';
      }
      save();
      recomposeMenu();
      const names = (state.todayMenu || []).map(m => { const r = recipeById(m.id); return r ? r.name : ''; }).filter(Boolean);
      const parts = [];
      if(act.servings) parts.push(state.settings.servings + ' 人份');
      if(act.mode) parts.push(AI_MODE_LABELS[act.mode] || act.mode);
      if(act.dishCount) parts.push(state.settings.dishCount + ' 道');
      const paramStr = parts.length ? '「' + parts.join(' · ') + '」' : '';
      reply += '🍽️ 已按' + paramStr + '配好 ' + names.length + ' 道：\n' + names.map(n => '· ' + n).join('\n');
      acts.push({ label: '🍳 去推荐页', act: 'goto-recommend' });
    }
    else if(act.type === 'checkDish'){
      const hit = findBestRecipe(act.name);
      if(!hit){
        reply += '🤔 菜谱库里没有找到「' + act.name + '」相近的菜，可以在菜谱页手动添加。';
      } else {
        const servings = state.settings.servings || 2;
        const a = analyzeRecipe(hit.recipe, buildPantry(state.ingredients), servings, buildCtx());
        const missingTxt = a.missing.map(m => m.name + (m.amount ? '（需 ' + fmtQty(scaledAmount(hit.recipe, m, servings)) + (m.unit || '') + '）' : '')).join('、');
        const shortTxt = a.short.map(s => s.ing.name + '（需' + fmtQty(s.need) + (s.ing.unit || '') + '，只有' + fmtQty(s.have) + (s.ing.unit || '') + '）').join('、');
        if(a.enough){
          reply += '✅ 不用买！家里的食材够做《' + hit.recipe.name + '》（' + servings + ' 人份）。';
        } else {
          const parts = [];
          if(missingTxt) parts.push('需要购买：' + missingTxt);
          if(shortTxt) parts.push('量不够：' + shortTxt);
          reply += '📖 找到菜谱《' + hit.recipe.name + '》：\n' + parts.join('\n') + '\n其他食材家里都有。';
        }
        acts.push({ label: '👩‍🍳 查看做法', act: 'open-recipe', id: hit.recipe.id });
        acts.push({ label: '＋ 加入今日菜单', act: 'add-menu', id: hit.recipe.id });
      }
    }
    else if(act.type === 'removeFromMenu'){
      const name = String(act.name || '').trim();
      const before = (state.todayMenu || []).length;
      state.todayMenu = state.todayMenu.filter(m => {
        const r = recipeById(m.id);
        return !r || !r.name.includes(name);
      });
      const removed = before - state.todayMenu.length;
      reply += removed ? '🗑 已从菜单移除 ' + removed + ' 道（含「' + name + '」的菜）。' : '菜单里没有找到含「' + name + '」的菜。';
      acts.push({ label: '🍳 去推荐页', act: 'goto-recommend' });
    }
    else if(act.type === 'lockDish'){
      const name = String(act.name || '').trim();
      const item = (state.todayMenu || []).find(m => { const r = recipeById(m.id); return r && r.name.includes(name); });
      if(item){
        item.locked = act.locked !== false;
        reply += item.locked ? '🔒 已锁定《' + (recipeById(item.id)?.name || '') + '》，换搭配时保持不变。' : '🔓 已解锁。';
      } else {
        reply += '菜单里没有找到含「' + name + '」的菜。';
      }
      save();
    }
    else if(act.type === 'listExpiring'){
      const expiring = state.ingredients.filter(i => { const d = daysUntil(i.expiry); return d !== null && d <= 7; });
      if(expiring.length){
        reply += '⏰ 以下食材即将过期（7 天内）：\n' + expiring.map(i => {
          const d = daysUntil(i.expiry);
          return '· ' + i.name + '（' + (d <= 0 ? '今天' : d + '天后') + '过期）';
        }).join('\n');
      } else {
        reply += '✅ 近 7 天内没有要过期的食材。';
      }
    }
    else if(act.type === 'listMenu'){
      const menu = (state.todayMenu || []).map(m => recipeById(m.id)).filter(Boolean);
      if(menu.length){
        reply += '📋 今日菜单（' + menu.length + ' 道）：\n' + menu.map(r => '· ' + r.name).join('\n');
        acts.push({ label: '🍳 去推荐页', act: 'goto-recommend' });
      } else {
        reply += '📋 今日菜单还是空的，可以让我帮你搭配。';
      }
    }
    else if(act.type === 'listStock'){
      const expiring = state.ingredients.filter(isExpiringSoon);
      reply += '🧊 家里现有 ' + state.ingredients.length + ' 种食材：\n' +
        state.ingredients.map(i => '· ' + i.name + (typeof i.qty === 'number' ? ' ' + fmtQty(i.qty) + (i.unit || '') : '') + '（' + locText(i) + '）').join('\n') +
        (expiring.length ? '\n⏰ 快过期：' + expiring.map(i => i.name).join('、') : '');
    }
    else if(act.type === 'removeIngredient'){
      const name = String(act.name || '').trim();
      const before = state.ingredients.length;
      state.ingredients = state.ingredients.filter(i => !i.name.includes(name));
      const removed = before - state.ingredients.length;
      if(removed){
        reply += '🗑 已删除 ' + removed + ' 种食材（含「' + name + '」）。';
        acts.push({ label: '🥕 去食材页看看', act: 'goto-pantry' });
      } else {
        reply += '没有找到「' + name + '」的食材记录。';
      }
    }
    else if(act.type === 'findIngredientLoc'){
      const name = String(act.name || '').trim();
      const hits = state.ingredients.filter(i => i.name.includes(name));
      if(hits.length){
        reply += '📍 找到 ' + hits.length + ' 样含「' + name + '」的食材：\n' +
          hits.map(i => '· ' + i.name + '（' + locText(i) + '）' + (typeof i.qty === 'number' ? ' ' + fmtQty(i.qty) + (i.unit || '') : '')).join('\n');
      } else {
        reply += '没有找到「' + name + '」的食材记录。';
      }
    }
    else if(act.type === 'checkQty'){
      const name = String(act.name || '').trim();
      const hits = state.ingredients.filter(i => i.name.includes(name));
      if(hits.length){
        reply += '📦 含「' + name + '」的食材：\n' +
          hits.map(i => '· ' + i.name + '：' + (typeof i.qty === 'number' ? fmtQty(i.qty) + (i.unit || '') : '有（未记量）') + '，' + locText(i)).join('\n');
      } else {
        reply += '没有找到「' + name + '」的食材记录。';
      }
    }
    else if(act.type === 'clearMenu'){
      state.todayMenu = [];
      reply += '🗑 今日菜单已清空。';
    }
  }
  save();
  renderAll(true);
  return { reply: reply || '我在呢～可以让我：加食材、查菜、配菜、查库存、看过期提醒……', acts };
}

/* ================= 聊天面板 ================= */

const AIChat = {
  open(){
    openModal(`
      <div class="modal-head"><h2>🤖 AI 助手</h2><button class="close-x" data-action="close-modal">✕</button></div>
      <div class="modal-body ai-chat-body" id="aiMsgs"></div>
      <div class="ai-input-row">
        <input id="aiTextInput" placeholder="如：买了两斤猪肉放冷藏第一层" autocomplete="off">
        <button class="iconbtn ai-mic ${AIChat.srSupported() ? '' : 'hide'}" id="aiMicBtn" title="语音输入">🎤</button>
        <button class="btn btn-primary" id="aiSendBtn">发送</button>
      </div>`, 'modal-chat');
    AIChat.render();
    const input = document.getElementById('aiTextInput');
    input.addEventListener('keydown', e => { if(e.key === 'Enter') AIChat.send(); });
    document.getElementById('aiSendBtn').addEventListener('click', () => AIChat.send());
    const mic = document.getElementById('aiMicBtn');
    if(AIChat.srSupported()) mic.addEventListener('click', () => AIChat.voice(mic));
  },
  srSupported(){ return !!(window.SpeechRecognition || window.webkitSpeechRecognition); },
  close(){ closeModal(); },
  thinking: false,
  render(){
    const box = document.getElementById('aiMsgs');
    if(!box) return;
    box.innerHTML = (aiLog.length ? aiLog : [{ who: 'ai', text: '你好！我是食材管家助手 🤖\n可以试试这些：\n· "买了两斤猪肉放冷藏第一层"\n· "想吃青椒炒肉，还要买东西吗"\n· "今晚不知道吃什么"\n· "有什么快过期的"\n· "番茄炒蛋怎么做"' }])
      .map(m => {
        const acts = (m.acts || []).map(a => {
          let label = a.label, cls = 'chip clickable';
          if(a.act === 'add-menu'){
            const inMenu = (state.todayMenu || []).some(t => t.id === (a.id || ''));
            label = inMenu ? '✓ 已加入' : a.label;
            if(inMenu) cls += ' chip-green';
          }
          return `<button class="${cls}" data-ai-act="${a.act}" data-ai-id="${a.id || ''}">${label}</button>`;
        }).join('');
        return `<div class="ai-msg ${m.who}">${esc(m.text).replace(/\n/g, '<br>')}${acts ? `<div class="ai-acts">${acts}</div>` : ''}</div>`;
      }).join('') + (AIChat.thinking ? '<div class="ai-msg ai ai-typing">🤔 正在思考…</div>' : '');
    box.scrollTop = box.scrollHeight;
  },
  async send(){
    const input = document.getElementById('aiTextInput');
    const text = (input ? input.value : '').trim();
    if(!text || AIChat.thinking) return;
    input.value = '';
    aiLog.push({ who: 'user', text });
    AIChat.thinking = true;
    AIChat.render();
    let reply = '', acts = [];
    try {
      // 本地解析优先（快、可靠、离线）
      let parsed = aiLocalParse(text);
      // 本地不认识 → 尝试大模型
      if(!parsed && (state.settings.aiApiKey || '').trim()){
        try { parsed = await aiLLMParse(text); }
        catch(e){ aiLog.push({ who: 'ai', text: '⚠️ 大模型解析失败（' + e.message + '），试试更简单的说法。' }); }
      }
      if(!parsed) parsed = { reply: '这句我还没听懂～可以试试：\n· "买了两斤猪肉放冷藏第一层"\n· "想吃青椒炒肉，还要买东西吗"\n· "今晚不知道吃什么"\n· "有什么快过期的"\n· "鸡蛋在哪"', actions: [] };
      const res = executeAiActions(parsed.actions);
      reply = parsed.reply ? (parsed.reply + '\n' + res.reply) : res.reply;
      acts = res.acts;
    } catch(err){
      reply = '😵 出错了：' + err.message;
    }
    AIChat.thinking = false;
    aiLog.push({ who: 'ai', text: reply, acts });
    AIChat.render();
  },
  voice(btn){
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if(!SR){ toast('当前浏览器不支持语音输入'); return; }
    try {
      const rec = new SR();
      rec.lang = 'zh-CN';
      rec.interimResults = false;
      btn.textContent = '🔴';
      rec.onresult = e => {
        btn.textContent = '🎤';
        const text = e.results[0][0].transcript;
        const input = document.getElementById('aiTextInput');
        if(input){ input.value = text; AIChat.send(); }
      };
      rec.onerror = rec.onend = () => { btn.textContent = '🎤'; };
      rec.start();
    } catch(e){ btn.textContent = '🎤'; toast('语音启动失败：' + e.message); }
  }
};

/* ---------------- 聊天里的操作按钮 ---------------- */

document.addEventListener('click', e => {
  const btn = e.target.closest && e.target.closest('[data-ai-act]');
  if(!btn) return;
  const act = btn.dataset.aiAct, id = btn.dataset.aiId || '';
  if(act === 'goto-pantry'){ AIChat.close(); switchTab('pantry'); }
  else if(act === 'goto-recommend'){ AIChat.close(); switchTab('recommend'); }
  else if(act === 'open-recipe'){ renderRecipeModal(id); }
  else if(act === 'add-menu'){
    toggleTodayMenu(id);
    renderAll(true);
    AIChat.render();
  }
});
