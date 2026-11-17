(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var SKIES = {
    saturn: {
      cn: '土星',
      en: 'SATURN',
      ground: '#0a0a0c',
      paper: [241, 236, 227],
      amber: [233, 193, 122],
      flare: [227, 134, 108],
      glyph: '<circle cx="8" cy="8" r="3.4"/><ellipse cx="8" cy="8" rx="7" ry="2.3" transform="rotate(-14 8 8)"/>'
    },
    neptune: {
      cn: '海王星',
      en: 'NEPTUNE',
      ground: '#07090d',
      paper: [228, 233, 239],
      amber: [126, 174, 230],
      flare: [162, 199, 242],
      glyph: '<circle cx="8" cy="8" r="3.8"/><ellipse class="is-faint" cx="8" cy="8" rx="6.8" ry="2.1" transform="rotate(-14 8 8)"/>'
    },
    blackhole: {
      cn: '黑洞',
      en: 'BLACK HOLE',
      ground: '#060608',
      paper: [230, 228, 238],
      amber: [196, 135, 230],
      flare: [227, 134, 108],
      glyph: '<circle class="is-solid" cx="8" cy="8" r="2.7"/><circle cx="8" cy="8" r="4.5"/><ellipse class="is-faint" cx="8" cy="8" rx="7.2" ry="1.8" transform="rotate(-8 8 8)"/>'
    },
    betelgeuse: {
      cn: '参宿四',
      en: 'BETELGEUSE',
      ground: '#0c0a0a',
      paper: [239, 229, 220],
      amber: [210, 106, 76],
      flare: [226, 112, 143],
      glyph: '<circle class="is-solid" cx="8" cy="8" r="3.2"/><circle class="is-faint" cx="8" cy="8" r="6.2"/>'
    }
  };

  function getSky() {
    var attr = document.documentElement.getAttribute('data-theme');
    return SKIES[attr] ? attr : 'saturn';
  }

  var currentSky = getSky();

  /* ---- Boot Ring ---- */
  var bootEl = document.getElementById('boot');
  if (bootEl) {
    if (reduceMotion) {
      bootEl.classList.add('is-out');
    } else {
      setTimeout(function () {
        bootEl.classList.add('is-out');
      }, 480);
    }
  }

  /* ---- Top Nav (.snav) + Sky Switcher ---- */
  var snav = document.getElementById('snav');
  var snavRow = document.getElementById('snav-row');
  var snavDot = document.getElementById('snav-dot');
  var skyBtn = document.getElementById('snav-sky-btn');
  var skyGlyph = document.getElementById('snav-sky-glyph');
  var skyName = document.getElementById('snav-sky-name');
  var foldBtn = document.getElementById('snav-fold-btn');
  var pinBtn = document.getElementById('snav-pin');
  var skyOpts = [].slice.call(document.querySelectorAll('.sky-opt'));
  var navItems = snavRow ? [].slice.call(snavRow.querySelectorAll('a, button:not(.snav-fold-btn)')) : [];
  var themeTimer = 0;

  function moveDot(el) {
    if (!snavDot || !el) return;
    var x = el.offsetLeft + 1;
    snavDot.style.setProperty('--dot-x', x + 'px');
    snavDot.classList.add('is-on');
  }

  function clearDot() {
    if (!snavDot) return;
    var active = snavRow ? snavRow.querySelector('.is-on') : null;
    if (active) moveDot(active);
    else snavDot.classList.remove('is-on');
  }

  navItems.forEach(function (el) {
    el.addEventListener('mouseenter', function () { moveDot(el); });
    el.addEventListener('focus', function () { moveDot(el); });
  });
  if (snavRow) {
    snavRow.addEventListener('mouseleave', clearDot);
    snavRow.addEventListener('focusout', function () {
      setTimeout(function () {
        if (!snavRow.contains(document.activeElement)) clearDot();
      }, 0);
    });
  }

  function setSkyDrawer(open) {
    if (!snav || !skyBtn) return;
    var next = typeof open === 'boolean' ? open : !snav.classList.contains('is-sky');
    snav.classList.toggle('is-sky', next);
    skyBtn.setAttribute('aria-expanded', String(next));
  }

  function applySky(name, animate) {
    if (!SKIES[name]) name = 'saturn';
    currentSky = name;
    var cfg = SKIES[name];
    if (animate && !reduceMotion) {
      document.documentElement.classList.add('theme-switching');
      clearTimeout(themeTimer);
      themeTimer = setTimeout(function () {
        document.documentElement.classList.remove('theme-switching');
      }, 740);
    }
    if (name === 'saturn') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', name);
    var metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) metaTheme.setAttribute('content', cfg.ground);
    if (skyGlyph) skyGlyph.innerHTML = cfg.glyph;
    if (skyName) skyName.textContent = cfg.cn;
    skyOpts.forEach(function (btn) {
      btn.classList.toggle('is-active', btn.dataset.sky === name);
    });
    try { localStorage.setItem('sf-ws-sky', name); } catch (_) {}
    if (reduceMotion && typeof window.__wsRedraw === 'function') window.__wsRedraw();
    if (typeof window.__wsRebuildCelestial === 'function') {
      window.__wsRebuildCelestial(name);
    }
  }

  if (skyBtn) {
    skyBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      setSkyDrawer();
    });
  }

  skyOpts.forEach(function (btn) {
    btn.addEventListener('click', function () {
      applySky(btn.dataset.sky, true);
      setSkyDrawer(false);
    });
  });

  if (foldBtn && snav) {
    foldBtn.addEventListener('click', function () {
      snav.classList.add('is-folded');
      setSkyDrawer(false);
    });
  }
  if (pinBtn && snav) {
    pinBtn.addEventListener('click', function () {
      snav.classList.remove('is-folded');
    });
  }

  document.addEventListener('click', function (e) {
    if (snav && snav.classList.contains('is-sky') && !snav.contains(e.target)) {
      setSkyDrawer(false);
    }
  });

  applySky(currentSky, false);

  /* ---- Cabin State & Synchronization ---- */
  var deck = document.getElementById('ws-deck');
  var secs = deck ? [].slice.call(deck.querySelectorAll('.panel-sec')) : [];
  var chips = [].slice.call(document.querySelectorAll('.ws-chip'));
  var indexRows = [].slice.call(document.querySelectorAll('.horbit-index li'));
  var orbitLabels = [].slice.call(document.querySelectorAll('.horbit-label'));
  var orbitTags = [].slice.call(document.querySelectorAll('.horbit-tag'));
  var navAllBtn = document.getElementById('snav-all-btn');
  var order = secs.map(function (s) { return s.dataset.panel; });
  var currentZone = order[0] || 'core';
  var hoveredZoneIdx = -1;
  var activeZoneIdx = 0;

  function staggerItems(sec) {
    var items = sec.querySelectorAll('.item');
    for (var i = 0; i < items.length; i++) {
      items[i].style.setProperty('--i', i);
      items[i].style.animation = 'none';
      void items[i].offsetWidth;
      items[i].style.animation = '';
    }
  }

  function showZone(id, scrollIntoView) {
    currentZone = id;
    var isAll = id === 'all' || order.indexOf(id) < 0;
    activeZoneIdx = isAll ? -1 : order.indexOf(id);

    if (deck) deck.dataset.mode = isAll ? 'all' : 'one';
    secs.forEach(function (s) {
      var on = isAll || s.dataset.panel === id;
      if (on) {
        s.setAttribute('data-on', '');
        staggerItems(s);
      } else {
        s.removeAttribute('data-on');
      }
    });

    chips.forEach(function (c) {
      var on = isAll ? c.dataset.jump === 'all' : c.dataset.jump === id;
      c.setAttribute('aria-selected', String(on));
    });

    indexRows.forEach(function (li) {
      var z = li.dataset.zone;
      li.classList.toggle('is-on', !isAll && z === id);
    });

    if (navAllBtn) {
      navAllBtn.classList.toggle('is-on', isAll);
      clearDot();
    }

    if (history.replaceState) {
      history.replaceState(null, '', isAll ? location.pathname : '#' + id);
    }

    if (scrollIntoView && deck) {
      var top = deck.getBoundingClientRect().top + window.scrollY - 82;
      if (top > window.scrollY + 20) {
        window.scrollTo({ top: top, behavior: reduceMotion ? 'auto' : 'smooth' });
      }
    }
  }

  chips.forEach(function (c) {
    c.addEventListener('click', function () {
      showZone(c.dataset.jump, false);
    });
  });

  if (navAllBtn) {
    navAllBtn.addEventListener('click', function () {
      showZone(currentZone === 'all' ? (order[0] || 'core') : 'all', true);
    });
  }

  indexRows.forEach(function (li, idx) {
    var btn = li.querySelector('.horbit-index-a');
    if (!btn) return;
    btn.addEventListener('mouseenter', function () { hoveredZoneIdx = idx; });
    btn.addEventListener('mouseleave', function () { hoveredZoneIdx = -1; });
    btn.addEventListener('click', function () {
      showZone(li.dataset.zone, true);
    });
  });

  orbitLabels.forEach(function (el, idx) {
    el.addEventListener('mouseenter', function () { hoveredZoneIdx = idx; });
    el.addEventListener('mouseleave', function () { hoveredZoneIdx = -1; });
    el.addEventListener('click', function () {
      showZone(el.dataset.zone, true);
    });
  });

  orbitTags.forEach(function (el, idx) {
    el.addEventListener('mouseenter', function () { hoveredZoneIdx = idx; });
    el.addEventListener('mouseleave', function () { hoveredZoneIdx = -1; });
    el.addEventListener('click', function () {
      showZone(el.dataset.zone, true);
    });
  });

  window.addEventListener('hashchange', function () {
    var id = location.hash.slice(1);
    showZone(order.indexOf(id) >= 0 ? id : 'all', false);
  });

  var initialHash = location.hash.replace('#', '');
  showZone(order.indexOf(initialHash) >= 0 ? initialHash : (order[0] || 'core'), false);

  /* ---- Mission Elapsed Time (X230) ---- */
  var metEl = document.getElementById('ws-met');
  var metTimer = 0;
  var epoch = Date.UTC(2025, 3, 1, 0, 0, 0);
  function pad2(v) { return v < 10 ? '0' + v : String(v); }
  function tickMet() {
    if (!metEl) return;
    var diff = Math.max(0, Math.floor((Date.now() - epoch) / 1000));
    var d = Math.floor(diff / 86400);
    var h = Math.floor((diff % 86400) / 3600);
    var m = Math.floor((diff % 3600) / 60);
    var s = diff % 60;
    metEl.textContent = d + ' 天 ' + pad2(h) + ':' + pad2(m) + ':' + pad2(s);
  }
  function syncMet() {
    if (document.hidden) {
      if (metTimer) { clearInterval(metTimer); metTimer = 0; }
      return;
    }
    tickMet();
    if (!metTimer) metTimer = setInterval(tickMet, 1000);
  }
  if (metEl) syncMet();

  /* ---- Quota Drawer (/workspace/quota.php) ---- */
  var qBox = document.getElementById('ws-quota');
  var qToggle = document.getElementById('ws-quota-toggle');
  var qDetailBtn = document.getElementById('ws-qbtn-detail');
  var qRefreshBtn = document.getElementById('ws-qbtn-refresh');
  var qDrawer = document.getElementById('ws-quota-drawer');
  var qChips = document.getElementById('ws-qchips');
  var qTime = document.getElementById('ws-qtime');
  var qGrid = document.getElementById('ws-qgrid');
  var qFetchedAt = 0;
  var qLastChipsHtml = '';
  var qLastProvidersJson = '';

  function applyLiveTime(el, iso, source) {
    if (!el) return;
    var t = iso ? new Date(iso) : new Date();
    if (isNaN(t.getTime())) t = new Date();
    var hms = t.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    var isLive = source === 'live';
    el.classList.add('ws-live-tag');
    el.classList.toggle('is-live', isLive);
    el.classList.toggle('is-cache', !isLive);
    el.textContent = (isLive ? '实时 ' : '缓存 ') + hms;
  }

  function escHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function qLvl(leftPct) {
    if (leftPct < 15) return 'crit';
    if (leftPct < 35) return 'warn';
    return 'ok';
  }
  function fmtQReset(iso) {
    if (!iso) return '';
    var dt = new Date(iso);
    if (isNaN(dt.getTime())) return '';
    var diffMs = dt.getTime() - Date.now();
    var hhmm = dt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    if (diffMs <= 0) return '即将重置';
    var mins = Math.floor(diffMs / 60000);
    var d = Math.floor(mins / 1440);
    var h = Math.floor((mins % 1440) / 60);
    var m = mins % 60;
    var rel = d > 0 ? (d + '天' + h + '小时') : (h > 0 ? (h + '小时' + m + '分') : (m + '分'));
    return rel + '后重置 (' + hhmm + ')';
  }
  var qUsage = document.getElementById('ws-qusage');
  var qLastUsageJson = '';
  function fmtTok(n) {
    var v = Number(n) || 0;
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return String(Math.round(v));
  }
  function fmtUsdCny(usd, cny) {
    return '$' + Number(usd || 0).toFixed(2) + ' / ¥' + Number(cny || 0).toFixed(0);
  }
  function renderUsage(u) {
    if (!qUsage) return;
    if (!u || !u.totalTokens) {
      qUsage.hidden = true;
      qUsage.innerHTML = '';
      qLastUsageJson = '';
      return;
    }
    var jsonStr = JSON.stringify(u);
    if (jsonStr === qLastUsageJson) return;
    qLastUsageJson = jsonStr;
    var br = u.breakdown || {};
    var confirmed = u.confirmedBilledUsd;
    var estimated = Number(u.estimatedPaygUsd || 0);
    var native = u.nativeAntigravity;
    var nativeStatus = native ? ((native.complete ? '' : '统计存在缺口；') + 'Antigravity 原生：' + native.files + ' 个库 · ' + native.generations + ' 次生成；读取失败 ' + native.failedFiles + '，异常记录 ' + native.invalidRows + '，未解析旧文件 ' + native.legacyFiles + '。订阅额度百分比不能直接换算为费用；原生模型单价映射尚未逐项核价。') : 'Antigravity 原生统计状态尚未获取。';
    var rowsHtml = (Array.isArray(u.byProvider) ? u.byProvider : []).map(function (r) {
      var share = u.totalTokens > 0 ? Math.min(100, (r.totalTokens / u.totalTokens) * 100) : 0;
      var models = Array.isArray(r.topModels) ? r.topModels.slice(0, 2).map(function (m) { return m.name + ' ' + fmtTok(m.tokens); }).join(' · ') : '';
      var isSub = r.billingMode === 'subscription';
      var badgeCls = isSub ? 'is-sub' : 'is-payg';
      var badgeTxt = isSub ? '订阅调用' : (r.paygSource === 'api_billed' ? '按量实扣' : '按量估算');
      var costPrimary = r.unpricedTokens > 0
        ? '金额待核价 <span class="ws-qu-subval">（已补齐日志 Token，单价未核实）</span>'
        : isSub
        ? ('订阅 <span class="ws-qu-subval">(参考 $' + Number(r.apiValueUsd || 0).toFixed(2) + ' / ¥' + Number(r.apiValueCny || 0).toFixed(0) + ')</span>')
        : ('<strong>$' + Number(r.paygSpentUsd || 0).toFixed(2) + '</strong> <span class="ws-qu-subval">(¥' + Number(r.paygSpentCny || 0).toFixed(1) + ')</span>');
      return (
        '<div class="ws-qu-row">' +
          '<div class="ws-qu-prov">' +
            '<div class="ws-qu-name">' + escHtml(r.label) + '<span class="ws-qu-badge ' + badgeCls + '">' + escHtml(badgeTxt) + '</span></div>' +
            '<div class="ws-qu-meta">' + escHtml((r.sources || []).join(' · ') + (r.sessions ? (' · ' + r.sessions + ' 会话') : '') + (models ? (' · ' + models) : '')) + '</div>' +
          '</div>' +
          '<div class="ws-qu-tok">' +
            '<div class="ws-qu-tokline"><span title="' + escHtml(Number(r.totalTokens || 0).toLocaleString('zh-CN')) + '">' + escHtml(fmtTok(r.totalTokens)) + '</span><span class="ws-qu-pct">' + share.toFixed(1) + '%</span></div>' +
            '<div class="ws-qu-bar"><i style="width:' + Math.max(1.5, share).toFixed(1) + '%"></i></div>' +
            '<div class="ws-qu-split">入 ' + escHtml(fmtTok(r.inputUncached)) + ' · 命中 ' + escHtml(fmtTok(r.cacheRead)) + ' · 出 ' + escHtml(fmtTok(r.output)) + '</div>' +
          '</div>' +
          '<div class="ws-qu-cost">' +
            '<div>' + costPrimary + '</div>' +
            '<div class="ws-qu-note">' + escHtml(r.billingDetail || '') + '</div>' +
          '</div>' +
        '</div>'
      );
    }).join('');
    qUsage.hidden = false;
    qUsage.innerHTML =
      '<div class="ws-qu-head">' +
        '<div class="ws-qu-title">TOKENS &amp; COST <span class="ws-qu-kicker">本机日志累计 · 参考估价与实扣分列</span></div>' +
        '<div class="ws-qu-kpis">' +
          '<div class="ws-qu-kpi"><span class="ws-qu-klbl">日志 TOKEN</span><strong class="ws-qu-kval" title="' + escHtml(Number(u.totalTokens).toLocaleString('zh-CN')) + '">' + escHtml(fmtTok(u.totalTokens)) + '</strong><span class="ws-qu-ksub">非缓存 ' + escHtml(fmtTok(br.inputUncached)) + ' · 缓存 ' + escHtml(fmtTok(br.cacheRead)) + ' · 输出 ' + escHtml(fmtTok(br.output)) + '</span></div>' +
          '<div class="ws-qu-kpi"><span class="ws-qu-klbl">API 参考估价' + (u.unpricedTokens > 0 ? '（部分）' : '') + '</span><strong class="ws-qu-kval is-amber">' + escHtml(fmtUsdCny(u.apiValueUsd, u.apiValueCny)) + '</strong><span class="ws-qu-ksub">' + (u.unpricedTokens > 0 ? escHtml(fmtTok(u.unpricedTokens)) + ' Token 尚未核价；' : '') + '配置单价折算 · 非账单</span></div>' +
          '<div class="ws-qu-kpi"><span class="ws-qu-klbl">接口累计实扣 · XPeach</span><strong class="ws-qu-kval">' + (confirmed == null ? '暂未获取' : ('$' + Number(confirmed).toFixed(2))) + '</strong><span class="ws-qu-ksub">另有日志按量估算 $' + estimated.toFixed(2) + ' · 不合并为实际支出</span></div>' +
        '</div>' +
      '</div>' +
      '<div class="ws-qu-list">' + rowsHtml + '</div>' +
      '<div class="ws-qu-foot">' + escHtml(nativeStatus) + '</div>' +
      (u.methodology ? '<div class="ws-qu-foot">' + escHtml(u.methodology) + '</div>' : '');
  }
  function qChip(label, val, lvl, extraCls) {
    return '<span class="ws-qchip' + (extraCls ? (' ' + extraCls) : '') + '"><span class="ws-qdot ' + lvl + '"></span>' + escHtml(label) + ' ' + escHtml(val) + '</span>';
  }
  function renderQuota(data) {
    if (!data || !Array.isArray(data.providers) || !qChips || !qGrid) return;
    if (data.vpn) renderVpn(data.vpn, data.updatedAt, data.source);
    var agy = data.providers.find(function (p) { return p.id === 'agy'; });
    var cdx = data.providers.find(function (p) { return p.id === 'codex'; });
    var ds = data.providers.find(function (p) { return p.id === 'deepseek'; });
    var xp = data.providers.find(function (p) { return p.id === 'xpeach'; });
    var chipHtml = [];
    if (agy && agy.status === 'ok' && Array.isArray(agy.items)) {
      var ar = agy.items.find(function (i) { return i.key === 'argon-w'; });
      var gw = agy.items.find(function (i) { return i.key === 'gem-w'; });
      var g5 = agy.items.find(function (i) { return i.key === 'gem-5h'; });
      var cw = agy.items.find(function (i) { return i.key === '3p-w'; });
      if (ar) chipHtml.push(qChip('Ar', Math.round(ar.leftPct) + '%', qLvl(ar.leftPct)));
      if (gw && g5) chipHtml.push(qChip('Gem', Math.round(g5.leftPct) + '%/' + Math.round(gw.leftPct) + '%', qLvl(Math.min(g5.leftPct, gw.leftPct))));
      else if (g5) chipHtml.push(qChip('Gem', Math.round(g5.leftPct) + '%', qLvl(g5.leftPct)));
      if (cw) chipHtml.push(qChip('3p', Math.round(cw.leftPct) + '%', qLvl(cw.leftPct)));
    }
    if (cdx && cdx.status === 'ok' && Array.isArray(cdx.items)) {
      var c5 = cdx.items.find(function (i) { return i.label && i.label.indexOf('5h') >= 0; });
      var cw2 = cdx.items.find(function (i) { return i.label && i.label.indexOf('周') >= 0; });
      if (c5 && cw2) chipHtml.push(qChip('Codex', Math.round(c5.leftPct) + '%/' + Math.round(cw2.leftPct) + '%', qLvl(Math.min(c5.leftPct, cw2.leftPct))));
    }
    if (ds && ds.status === 'ok' && ds.balanceNum != null) {
      chipHtml.push(qChip('DS', '¥' + Math.round(ds.balanceNum), ds.balanceNum < 10 ? 'warn' : 'ok'));
    }
    if (xp && xp.status === 'ok' && xp.usedText) {
      chipHtml.push(qChip('XP', xp.usedText, 'ok'));
    }
    if (data.usage && data.usage.totalTokens > 0) {
      chipHtml.push(qChip('Token', fmtTok(data.usage.totalTokens) + ' 日志累计', 'ok', 'is-usage'));
    }
    var nextChipsHtml = chipHtml.length ? chipHtml.join('') : '额度暂不可用';
    if (nextChipsHtml !== qLastChipsHtml) {
      qLastChipsHtml = nextChipsHtml;
      qChips.innerHTML = nextChipsHtml;
    }
    applyLiveTime(qTime, data.updatedAt, data.source);
    var nextProvidersJson = JSON.stringify(data.providers);
    if (nextProvidersJson !== qLastProvidersJson) {
      qLastProvidersJson = nextProvidersJson;
      qGrid.innerHTML = data.providers.map(function (p, idx) {
        var body = '';
        if (p.status !== 'ok') {
          body = '<div class="ws-qerr">' + escHtml(p.error || '查询失败') + '</div>';
        } else if (Array.isArray(p.items)) {
          body = p.items.map(function (it) {
            var cls = qLvl(it.leftPct);
            var rst = fmtQReset(it.resetAt);
            return '<div class="ws-qrow"><div class="ws-qrow-line"><span>' + escHtml(it.label) + '</span><span class="ws-qrow-val">剩 ' + escHtml(it.leftPct) + '%</span></div><div class="ws-qbar"><i class="' + cls + '" style="width:' + Math.max(2, Math.min(100, Number(it.leftPct) || 0)) + '%"></i></div>' + (rst ? '<div class="ws-qreset">' + escHtml(rst) + '</div>' : '') + '</div>';
          }).join('');
        } else if (p.balance) {
          body = '<div class="ws-qrow"><div class="ws-qrow-line"><span>可用余额</span><span class="ws-qrow-val">' + escHtml(p.balance) + '</span></div><div class="ws-qbar"><i class="ok" style="width:100%"></i></div>' + (p.detail ? '<div class="ws-qreset">' + escHtml(p.detail) + '</div>' : '') + '</div>';
        } else if (p.usedText) {
          body = '<div class="ws-qrow"><div class="ws-qrow-line"><span>已用额度</span><span class="ws-qrow-val">' + escHtml(p.usedText) + '</span></div><div class="ws-qbar"><i class="ok" style="width:100%"></i></div>' + (p.detail ? '<div class="ws-qreset">' + escHtml(p.detail) + '</div>' : '') + '</div>';
        }
        return '<div class="ws-qcard" style="--qi:' + idx + '"><div class="ws-qcard-top"><span class="ws-qcard-name">' + escHtml(p.name) + '</span><span class="ws-qcard-plan">' + escHtml(p.plan || '') + '</span></div>' + body + '</div>';
      }).join('');
    }
    renderUsage(data.usage);
  }
  var qPending = false;
  function loadQuota(force) {
    if (!qChips || !window.fetch || location.protocol === 'file:') return;
    if (qPending) return;
    qPending = true;
    var isForce = force === true;
    if (isForce) {
      if (qRefreshBtn) qRefreshBtn.disabled = true;
      if (vpnRefreshBtn) vpnRefreshBtn.disabled = true;
    }
    qBox.setAttribute('aria-busy', 'true');
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, isForce ? 12000 : 8000);
    fetch('/workspace/quota.php' + (isForce ? '?force=1' : ''), { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
      .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(function (d) {
        if (!d || !Array.isArray(d.providers)) throw new Error('invalid quota');
        renderQuota(d);
        qFetchedAt = Date.now();
      })
      .catch(function () {
        if (!qLastProvidersJson) {
          qChips.textContent = '额度刷新失败，点击右侧重试';
          if (qTime) qTime.textContent = '未同步';
          if (qGrid) qGrid.innerHTML = '<p class="ws-qerr">暂时无法获取额度，请稍后重试。</p>';
        }
      })
      .finally(function () {
        clearTimeout(timeout);
        qPending = false;
        qBox.setAttribute('aria-busy', 'false');
        if (qRefreshBtn) { qRefreshBtn.disabled = false; qRefreshBtn.classList.remove('is-spin'); }
        if (vpnRefreshBtn) { vpnRefreshBtn.disabled = false; vpnRefreshBtn.classList.remove('is-spin'); }
      });
  }
  function toggleQuota(open) {
    if (!qBox || !qDrawer || !qToggle) return;
    var next = typeof open === 'boolean' ? open : !qBox.classList.contains('is-open');
    qBox.classList.toggle('is-open', next);
    qDrawer.setAttribute('aria-hidden', String(!next));
    qToggle.setAttribute('aria-expanded', String(next));
    if (qDetailBtn) qDetailBtn.innerHTML = (next ? '收起 ' : '详情 ') + '<span class="ws-qchev">▾</span>';
  }
  if (qToggle) qToggle.addEventListener('click', function () { toggleQuota(); });
  if (qDetailBtn) qDetailBtn.addEventListener('click', function () { toggleQuota(); });
  if (qRefreshBtn) qRefreshBtn.addEventListener('click', function () {
    qRefreshBtn.classList.remove('is-spin');
    void qRefreshBtn.offsetWidth;
    qRefreshBtn.classList.add('is-spin');
    loadQuota(true);
  });
  if (qChips) {
    loadQuota(false);
    setInterval(function () { if (!document.hidden) loadQuota(false); }, 5000);
  }

  /* ---- VPN Traffic & Link Reporting (/workspace/quota.php -> data.vpn) ---- */
  var vpnBox = document.getElementById('ws-vpn');
  var vpnPill = document.getElementById('ws-vpn-pill');
  var vpnTime = document.getElementById('ws-vpn-time');
  var vpnCopyBtn = document.getElementById('ws-vpn-copy');
  var vpnCopyBtn2 = document.getElementById('ws-vpn-copy-2');
  var vpnToggleBtn = document.getElementById('ws-vpn-toggle');
  var vpnRefreshBtn = document.getElementById('ws-vpn-refresh');
  var vpnDrawer = document.getElementById('ws-vpn-drawer');
  var vpnProvider = document.getElementById('ws-vpn-provider');
  var vpnSummary = document.getElementById('ws-vpn-summary');
  var vpnBarUp = document.getElementById('ws-vpn-bar-up');
  var vpnBarDown = document.getElementById('ws-vpn-bar-down');
  var vpnIo = document.getElementById('ws-vpn-io');
  var vpnIoSub = document.getElementById('ws-vpn-io-sub');
  var vpnLeft = document.getElementById('ws-vpn-left');
  var vpnExp = document.getElementById('ws-vpn-exp');
  var vpnNode = document.getElementById('ws-vpn-node');
  var vpnNodeSub = document.getElementById('ws-vpn-node-sub');
  var vpnSess = document.getElementById('ws-vpn-sess');
  var vpnSessSub = document.getElementById('ws-vpn-sess-sub');
  var vpnDays = document.getElementById('ws-vpn-days');
  var vpnReportEl = document.getElementById('ws-vpn-report');
  var lastVpnReportText = '';

  function fmtBytes(b) {
    var n = Number(b);
    if (!Number.isFinite(n) || n < 0) return '--';
    var gib = n / 1073741824;
    if (gib >= 1024) return (gib / 1024).toFixed(2) + ' TiB';
    if (gib >= 1) return gib.toFixed(2) + ' GiB';
    var mib = n / 1048576;
    if (mib >= 1) return mib.toFixed(1) + ' MiB';
    return Math.round(n / 1024) + ' KiB';
  }

  function fmtExpireInfo(iso) {
    if (!iso) return '到期时间未知';
    var dt = new Date(iso);
    if (isNaN(dt.getTime())) return '到期时间未知';
    var dateStr = dt.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
    var hm = dt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    var daysLeft = Math.max(0, Math.ceil((dt.getTime() - Date.now()) / 86400000));
    return dateStr + ' ' + hm + '（剩约 ' + daysLeft + ' 天）';
  }

  function renderVpn(vpn, updatedAt, source) {
    if (!vpnBox || !vpn) return;
    var sub = vpn.subscription || null;
    var cl = vpn.clash || null;

    applyLiveTime(vpnTime, vpn.updatedAt || updatedAt, source);
    if (vpnProvider && vpn.provider) {
      vpnProvider.textContent = vpn.provider;
    }

    // Pill indicator
    if (vpnPill) {
      if (cl && cl.status === 'ok' && cl.activeNode) {
        var delayStr = cl.delayMs != null ? (' · ' + cl.delayMs + ' ms') : '';
        var speedStr = (cl.downSpeedBps != null) ? (' · ↓ ' + fmtBytes(cl.downSpeedBps) + '/s') : '';
        var pLvl = (sub && sub.leftPct < 15) ? 'crit' : ((sub && sub.leftPct < 35) ? 'warn' : 'ok');
        vpnPill.innerHTML = '<span class="ws-qdot ' + pLvl + '"></span>' + escHtml(cl.activeNode + delayStr + speedStr);
      } else {
        vpnPill.innerHTML = '<span class="ws-qdot warn"></span>' + escHtml(vpn.error || '链路监测中');
      }
    }

    if (sub) {
      var upPct = sub.totalBytes > 0 ? Math.min(100, (sub.uploadBytes / sub.totalBytes) * 100) : 0;
      var downPct = sub.totalBytes > 0 ? Math.min(100 - upPct, (sub.downloadBytes / sub.totalBytes) * 100) : 0;
      if (vpnBarUp) vpnBarUp.style.width = upPct.toFixed(2) + '%';
      if (vpnBarDown) vpnBarDown.style.width = downPct.toFixed(2) + '%';
      if (vpnSummary) {
        vpnSummary.textContent = '已用 ' + fmtBytes(sub.usedBytes) + ' / ' + fmtBytes(sub.totalBytes) + ' (' + sub.usedPct + '%) · 剩余 ' + fmtBytes(sub.leftBytes) + ' (' + sub.leftPct + '%)';
      }
      if (vpnIo) vpnIo.textContent = '↑ ' + fmtBytes(sub.uploadBytes) + ' / ↓ ' + fmtBytes(sub.downloadBytes);
      if (vpnIoSub) vpnIoSub.textContent = '总计已用 ' + fmtBytes(sub.usedBytes) + ' · 今日 +' + fmtBytes(vpn.todayUsedBytes || 0);
      if (vpnLeft) vpnLeft.textContent = fmtBytes(sub.leftBytes) + ' (' + sub.leftPct + '%)';
      if (vpnExp) vpnExp.textContent = fmtExpireInfo(sub.expireAt);
    } else {
      if (vpnSummary) vpnSummary.textContent = vpn.error || '订阅用量暂不可用';
      if (vpnIo) vpnIo.textContent = '-- / --';
      if (vpnIoSub) vpnIoSub.textContent = '等待订阅同步';
      if (vpnLeft) vpnLeft.textContent = '--';
      if (vpnExp) vpnExp.textContent = '--';
    }

    if (cl && cl.status === 'ok') {
      if (vpnNode) vpnNode.textContent = cl.activeNode || '--';
      if (vpnNodeSub) {
        var pinText = cl.pinTarget ? (cl.pinActive ? '已锁定目标' : '未强制锁定') : '';
        vpnNodeSub.textContent = [cl.protocol || '', cl.delayMs != null ? (cl.delayMs + ' ms') : '', pinText].filter(Boolean).join(' · ') || '--';
      }
      if (cl.upSpeedBps != null && cl.downSpeedBps != null) {
        if (vpnSess) vpnSess.textContent = '↑ ' + fmtBytes(cl.upSpeedBps) + '/s · ↓ ' + fmtBytes(cl.downSpeedBps) + '/s';
        if (vpnSessSub) vpnSessSub.textContent = '累计 ↑ ' + fmtBytes(cl.sessionUploadBytes) + ' ↓ ' + fmtBytes(cl.sessionDownloadBytes) + ' · ' + (cl.activeConnections || 0) + ' 连接';
      } else {
        if (vpnSess) vpnSess.textContent = '↑ ' + fmtBytes(cl.sessionUploadBytes) + ' / ↓ ' + fmtBytes(cl.sessionDownloadBytes);
        if (vpnSessSub) vpnSessSub.textContent = 'Clash 活跃连接 ' + (cl.activeConnections || 0) + ' 条（本次启动累计）';
      }
    } else {
      if (vpnNode) vpnNode.textContent = '--';
      if (vpnNodeSub) vpnNodeSub.textContent = (cl && cl.error) ? cl.error : 'Clash 离线';
      if (vpnSess) vpnSess.textContent = '-- / --';
      if (vpnSessSub) vpnSessSub.textContent = '--';
    }

    // 7-day trend rows
    var histDays = Array.isArray(vpn.historyDays) ? vpn.historyDays : [];
    if (vpnDays) {
      if (histDays.length) {
        var maxDelta = Math.max.apply(null, histDays.map(function (d) { return Number(d.deltaBytes || 0); }).concat([1048576]));
        vpnDays.innerHTML = '<div class="ws-vpn-days-title">近 ' + histDays.length + ' 日订阅增量</div>' + histDays.slice().reverse().map(function (d) {
          var pct = Math.min(100, Math.round((Number(d.deltaBytes || 0) / maxDelta) * 100));
          return '<div class="ws-vpn-day-row"><span>' + escHtml(d.date.slice(5)) + '</span><span class="ws-vpn-day-bar"><i style="width:' + pct + '%"></i></span><span class="ws-vpn-day-val">+' + escHtml(fmtBytes(d.deltaBytes || 0)) + '</span></div>';
        }).join('');
      } else {
        vpnDays.innerHTML = '<div class="ws-vpn-days-title">每日增量记录初始化中</div>';
      }
    }

    // Build standardized plaintext report
    var repTime = new Date(vpn.updatedAt || updatedAt || Date.now()).toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    }).replace(/\//g, '-');
    var lines = ['【VPN 用量汇报 · ' + repTime + '】'];
    if (sub) {
      lines.push('- 订阅额度：已用 ' + fmtBytes(sub.usedBytes) + ' / ' + fmtBytes(sub.totalBytes) + '（' + sub.usedPct + '%），剩余 ' + fmtBytes(sub.leftBytes) + '（' + sub.leftPct + '%）');
      lines.push('- 订阅分项：上行 ' + fmtBytes(sub.uploadBytes) + ' / 下行 ' + fmtBytes(sub.downloadBytes) + '（今日新增 +' + fmtBytes(vpn.todayUsedBytes || 0) + '）');
      lines.push('- 到期时间：' + fmtExpireInfo(sub.expireAt));
    }
    if (cl && cl.status === 'ok') {
      lines.push('- X230 出口：' + (cl.activeNode || '--') + (cl.protocol ? '（' + cl.protocol + (cl.delayMs != null ? ' · ' + cl.delayMs + ' ms' : '') + '）' : ''));
      if (cl.upSpeedBps != null && cl.downSpeedBps != null) {
        lines.push('- 实时速率：上行 ' + fmtBytes(cl.upSpeedBps) + '/s / 下行 ' + fmtBytes(cl.downSpeedBps) + '/s（活跃连接 ' + (cl.activeConnections || 0) + '）');
      }
      lines.push('- 本机隧道：上行 ' + fmtBytes(cl.sessionUploadBytes) + ' / 下行 ' + fmtBytes(cl.sessionDownloadBytes) + '（本次启动累计）');
    }
    lastVpnReportText = lines.join('\n');
    if (vpnReportEl) vpnReportEl.textContent = lastVpnReportText;
  }

  function copyVpnReport(btn) {
    var text = lastVpnReportText || (vpnReportEl ? vpnReportEl.textContent : '');
    if (!text) return;
    var ok = function () {
      if (!btn) return;
      var orig = btn.dataset.orig || btn.textContent;
      btn.dataset.orig = orig;
      btn.textContent = '已复制 ✓';
      setTimeout(function () { btn.textContent = orig; }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok, function () {});
    } else {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); ok(); } catch (e) {}
      document.body.removeChild(ta);
    }
  }

  function toggleVpnDrawer(open) {
    if (!vpnBox || !vpnDrawer || !vpnToggleBtn) return;
    var next = typeof open === 'boolean' ? open : !vpnBox.classList.contains('is-open');
    vpnBox.classList.toggle('is-open', next);
    vpnDrawer.setAttribute('aria-hidden', String(!next));
    vpnToggleBtn.setAttribute('aria-expanded', String(next));
    vpnToggleBtn.innerHTML = (next ? '收起 ' : '汇报单 ') + '<span class="ws-qchev">▾</span>';
  }

  if (vpnToggleBtn) vpnToggleBtn.addEventListener('click', function () { toggleVpnDrawer(); });
  if (vpnCopyBtn) vpnCopyBtn.addEventListener('click', function () { copyVpnReport(vpnCopyBtn); });
  if (vpnCopyBtn2) vpnCopyBtn2.addEventListener('click', function () { copyVpnReport(vpnCopyBtn2); });
  if (vpnRefreshBtn) vpnRefreshBtn.addEventListener('click', function () {
    vpnRefreshBtn.classList.remove('is-spin');
    void vpnRefreshBtn.offsetWidth;
    vpnRefreshBtn.classList.add('is-spin');
    loadQuota(true);
  });

  /* ---- Codeforces Status (/workspace/cf.php) ---- */
  var cfBox = document.getElementById('ws-cf');
  var cfToggleBtn = document.getElementById('ws-cf-toggle');
  var cfDetailBtn = document.getElementById('ws-cf-btn-detail');
  var cfRefreshBtn = document.getElementById('ws-cf-refresh');
  var cfDrawer = document.getElementById('ws-cf-drawer');
  var cfSummary = document.getElementById('ws-cf-summary');
  var cfGrid = document.getElementById('ws-cf-grid');

  function toggleCfDrawer(open) {
    if (!cfBox || !cfDrawer) return;
    var next = typeof open === 'boolean' ? open : !cfBox.classList.contains('is-open');
    cfBox.classList.toggle('is-open', next);
    cfDrawer.setAttribute('aria-hidden', String(!next));
    if (cfToggleBtn) cfToggleBtn.setAttribute('aria-expanded', String(next));
    if (cfDetailBtn) cfDetailBtn.innerHTML = (next ? '收起 ' : '详情 ') + '<span class="ws-qchev">▾</span>';
  }

  function renderCf(d) {
    if (!d || !d.profile) return;
    var p = d.profile;
    var st = d.stats || {};
    var ratingText = p.rating ? (p.rating + ' · ' + (p.rank || '')) : 'Unrated';
    if (cfSummary) {
      cfSummary.textContent = (p.handle || 'zhang_tian_si_or_a_li') + ' · ' + ratingText + ' · 近60交 ' + (st.recentAc || 0) + ' AC / ' + (st.unsolvedCount || 0) + ' 待补';
    }
    if (!cfGrid) return;
    var subs = Array.isArray(d.submissions) ? d.submissions : [];
    var wrongs = Array.isArray(d.wrongProblems) ? d.wrongProblems : [];
    var subHtml = subs.length
      ? subs.slice(0, 6).map(function (s) {
          var cls = s.verdict === 'OK' ? 'ws-cf-ok' : 'ws-cf-err';
          return '<a class="ws-cf-item" href="' + escHtml(s.submissionUrl || s.problemUrl || '#') + '" target="_blank" rel="noopener"><span>' + escHtml((s.code || '') + ' ' + (s.name || '')) + '</span><span class="' + cls + '">' + escHtml(s.verdict || '') + '</span></a>';
        }).join('')
      : '<div class="ws-qerr">暂无提交记录，去 <a href="/workspace/write/" style="color:var(--signal)">写作台</a> 或刷题工作区开第一题。</div>';
    var wrongHtml = wrongs.length
      ? wrongs.slice(0, 6).map(function (w) {
          return '<a class="ws-cf-item" href="' + escHtml(w.problemUrl || '#') + '" target="_blank" rel="noopener"><span>' + escHtml((w.code || '') + ' ' + (w.name || '')) + '</span><span class="ws-cf-err">' + escHtml(w.lastVerdict + ' ×' + w.attempts) + '</span></a>';
        }).join('')
      : '<div class="ws-qerr">暂无未 AC 错题。</div>';
    cfGrid.innerHTML =
      '<div class="ws-cf-card"><div class="ws-cf-card-hd">RECENT SUBMISSIONS / 近期提交</div><div class="ws-cf-list">' + subHtml + '</div></div>' +
      '<div class="ws-cf-card"><div class="ws-cf-card-hd">UNSOLVED / 待补错题</div><div class="ws-cf-list">' + wrongHtml + '</div></div>';
  }

  function loadCf(force) {
    if (!cfBox) return;
    if (cfRefreshBtn) cfRefreshBtn.disabled = true;
    fetch('/workspace/cf.php' + (force ? '?force=1' : ''), { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) { renderCf(d); })
      .catch(function (err) {
        if (cfSummary) cfSummary.textContent = 'zhang_tian_si_or_a_li · 读取失败 (' + err.message + ')';
      })
      .finally(function () { if (cfRefreshBtn) cfRefreshBtn.disabled = false; });
  }

  if (cfToggleBtn) cfToggleBtn.addEventListener('click', function () { toggleCfDrawer(); });
  if (cfDetailBtn) cfDetailBtn.addEventListener('click', function () { toggleCfDrawer(); });
  if (cfRefreshBtn) cfRefreshBtn.addEventListener('click', function () { loadCf(true); });
  if (cfBox) loadCf(false);

  /* ---- Command Palette (⌘K / /) ---- */
  var pal = document.getElementById('ws-pal');
  var palInput = document.getElementById('ws-pal-input');
  var palList = document.getElementById('ws-pal-list');
  var palEsc = document.getElementById('ws-pal-esc');
  var snavSearchBtn = document.getElementById('snav-search-btn');
  var palSelIdx = 0;
  var palResults = [];
  var palReturnFocus = null;

  var palEntries = [].slice.call(document.querySelectorAll('.panel-sec .item')).map(function (el) {
    var sec = el.closest('.panel-sec');
    return {
      kind: 'link',
      zone: sec ? sec.dataset.num + ' ' + sec.dataset.en : '',
      label: el.querySelector('.it-label') ? el.querySelector('.it-label').textContent : '',
      sub: el.querySelector('.it-sub') ? el.querySelector('.it-sub').textContent : '',
      tag: el.querySelector('.tag') ? el.querySelector('.tag').textContent : '',
      href: el.getAttribute('href'),
      search: (el.getAttribute('data-search') || '').toLowerCase()
    };
  });

  Object.keys(SKIES).forEach(function (k) {
    palEntries.push({
      kind: 'sky',
      zone: 'SKY',
      label: '切换天象 · ' + SKIES[k].cn,
      sub: SKIES[k].en,
      tag: 'THEME',
      sky: k,
      search: ('sky theme 天象 ' + SKIES[k].cn + ' ' + SKIES[k].en + ' ' + k).toLowerCase()
    });
  });

  if (vpnBox) {
    palEntries.push({
      kind: 'vpn',
      zone: 'VPN',
      label: 'VPN 流量与链路汇报',
      sub: '查看订阅剩余、节点延迟与一键复制汇报',
      tag: 'REPORT',
      search: 'vpn clash traffic report 流量 用量 汇报 节点 订阅'
    });
  }

  function renderPal(q) {
    if (!palList) return;
    var kw = (q || '').trim().toLowerCase();
    palResults = kw
      ? palEntries.filter(function (e) { return e.search.indexOf(kw) >= 0; })
      : palEntries.slice(0, 12);
    if (palSelIdx >= palResults.length) palSelIdx = 0;
    if (!palResults.length) {
      palInput.removeAttribute('aria-activedescendant');
      palList.innerHTML = '<li class="ws-pal-empty">没有匹配的入口或天象，按 Esc 返回。</li>';
      return;
    }
    palList.innerHTML = palResults.map(function (item, idx) {
      var cls = 'ws-pal-row' + (idx === palSelIdx ? ' is-sel' : '');
      var tagCls = item.tag === 'LAN' ? 'tag tag-lan' : (item.tag === 'GATE' ? 'tag tag-gate' : (item.tag === 'PUBLIC' ? 'tag tag-pub' : 'tag'));
      return '<li id="ws-pal-result-' + idx + '" role="option" aria-selected="' + (idx === palSelIdx) + '" data-idx="' + idx + '" class="' + cls + '">'
        + '<span class="ws-pal-zone">' + escHtml(item.zone) + '</span>'
        + '<span><span class="ws-pal-title">' + escHtml(item.label) + '</span>'
        + '<span class="ws-pal-sub">' + escHtml(item.sub) + '</span></span>'
        + '<span class="' + tagCls + '">' + escHtml(item.tag) + '</span>'
        + '</li>';
    }).join('');
    palInput.setAttribute('aria-activedescendant', 'ws-pal-result-' + palSelIdx);
    var selected = palList.querySelector('.is-sel');
    if (selected) selected.scrollIntoView({ block: 'nearest' });
  }

  function execPalItem(item) {
    if (!item) return;
    if (item.kind === 'sky') {
      applySky(item.sky, true);
      closePal();
      return;
    }
    if (item.kind === 'vpn') {
      closePal();
      if (vpnBox) {
        toggleVpnDrawer(true);
        vpnBox.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
      }
      return;
    }
    if (item.href) {
      window.open(item.href, '_blank', 'noopener');
      closePal();
    }
  }

  function openPal() {
    if (!pal || !palInput) return;
    palReturnFocus = document.activeElement;
    document.querySelector('main').inert = true;
    if (snav) snav.inert = true;
    document.body.classList.add('pal-open');
    pal.classList.add('is-open');
    pal.setAttribute('aria-hidden', 'false');
    palInput.value = '';
    palSelIdx = 0;
    renderPal('');
    palInput.focus({ preventScroll: true });
  }

  function closePal() {
    if (!pal) return;
    pal.classList.remove('is-open');
    pal.setAttribute('aria-hidden', 'true');
    document.querySelector('main').inert = false;
    if (snav) snav.inert = false;
    document.body.classList.remove('pal-open');
    if (palReturnFocus && palReturnFocus.isConnected) palReturnFocus.focus({ preventScroll: true });
  }

  if (snavSearchBtn) snavSearchBtn.addEventListener('click', openPal);
  if (palEsc) palEsc.addEventListener('click', closePal);
  if (pal) {
    pal.addEventListener('click', function (e) {
      if (e.target === pal) closePal();
    });
  }
  if (palList) {
    palList.addEventListener('click', function (e) {
      var row = e.target.closest('.ws-pal-row');
      if (!row) return;
      execPalItem(palResults[Number(row.dataset.idx)]);
    });
  }
  if (palInput) {
    palInput.addEventListener('input', function () {
      palSelIdx = 0;
      renderPal(palInput.value);
    });
    palInput.addEventListener('keydown', function (e) {
      if (e.isComposing) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (palResults.length) {
          palSelIdx = (palSelIdx + 1) % palResults.length;
          renderPal(palInput.value);
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (palResults.length) {
          palSelIdx = (palSelIdx - 1 + palResults.length) % palResults.length;
          renderPal(palInput.value);
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        execPalItem(palResults[palSelIdx]);
      }
    });
  }

  document.addEventListener('keydown', function (e) {
    if (e.isComposing) return;
    var palOpen = pal && pal.classList.contains('is-open');
    if (palOpen && e.key === 'Tab') {
      e.preventDefault();
      (document.activeElement === palInput ? palEsc : palInput).focus();
      return;
    }
    var editing = document.activeElement.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (palOpen) closePal(); else openPal();
      return;
    }
    if (e.key === '/' && !palOpen && !editing) {
      e.preventDefault();
      openPal();
      return;
    }
    if (e.key === 'Escape') {
      if (palOpen) { closePal(); return; }
      if (snav && snav.classList.contains('is-sky')) { setSkyDrawer(false); return; }
      showZone('all', false);
      return;
    }
    if (palOpen || editing) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      var cur = order.indexOf(currentZone);
      var next = e.key === 'ArrowRight'
        ? (cur < 0 ? 0 : (cur + 1) % order.length)
        : (cur < 0 ? order.length - 1 : (cur - 1 + order.length) % order.length);
      e.preventDefault();
      showZone(order[next], false);
    }
  });

  /* ---- Background Starfield + Comets (#cosmos-canvas) ---- */
  var bgCanvas = document.getElementById('cosmos-canvas');
  var bgCtx = bgCanvas ? bgCanvas.getContext('2d') : null;
  var bgStars = [];
  var comets = [];
  var ptrX = 0;
  var ptrY = 0;
  var smPtrX = 0;
  var smPtrY = 0;

  for (var si = 0; si < 165; si++) {
    bgStars.push({
      x: Math.random(),
      y: Math.random(),
      z: 0.2 + Math.random() * 0.8,
      r: 0.45 + Math.random() * 1.15,
      ph: Math.random() * Math.PI * 2,
      sp: 0.6 + Math.random() * 1.6,
      warm: Math.random() < 0.22
    });
  }

  function spawnComet(w, h) {
    var fromLeft = Math.random() < 0.65;
    comets.push({
      x: fromLeft ? Math.random() * w * 0.6 : w * (0.4 + Math.random() * 0.5),
      y: Math.random() * h * 0.35,
      vx: (fromLeft ? 1 : -1) * (240 + Math.random() * 180),
      vy: 110 + Math.random() * 90,
      life: 0,
      max: 0.9 + Math.random() * 0.65
    });
  }

  /* ---- Hero 3D Vector / Brushed Celestial Canvas (#pt-canvas) ---- */
  var ptCanvas = document.getElementById('pt-canvas');
  var ptCtx = ptCanvas ? ptCanvas.getContext('2d') : null;
  var horbit = document.getElementById('horbit');
  var celestialSpec = { moons: [] };

  // 6 Orbital Waypoints distributed cleanly around the outer ecliptic ellipse
  var ORBIT_NODES = [
    { angle: 1.98,  rx: 1.95, ry: 0.94 }, // 01 CORE (bottom-left)
    { angle: 0.52,  rx: 1.98, ry: 0.94 }, // 02 FILE (bottom-right)
    { angle: -0.46, rx: 2.02, ry: 0.96 }, // 03 NOTE (top-right)
    { angle: -1.52, rx: 1.86, ry: 0.96 }, // 04 FEED (top)
    { angle: -2.42, rx: 1.96, ry: 0.94 }, // 05 WATCH (top-left)
    { angle: 2.96,  rx: 2.08, ry: 0.92 }  // 00 REMOTE (left)
  ];

  // Fixed ringlet profiles generated deterministically (zero chunky polka-dot clusters)
  var SATURN_BRINGS = [];
  for (var ri = 0; ri < 24; ri++) {
    var rf = ri / 23;
    SATURN_BRINGS.push({
      r: 0.78 + rf * 0.28,
      w: 0.8 + (ri % 3 === 0 ? 0.5 : 0.15),
      a: 0.12 + 0.24 * Math.sin(rf * Math.PI) * (0.7 + 0.3 * Math.sin(ri * 2.1)),
      paper: ri % 4 === 1
    });
  }
  var SATURN_ARINGS = [];
  for (var ai = 0; ai < 14; ai++) {
    var af = ai / 13;
    // Slight Encke division gap around af ~ 0.65
    if (ai === 9) continue;
    SATURN_ARINGS.push({
      r: 1.13 + af * 0.21,
      w: 0.75 + (ai % 2 === 0 ? 0.3 : 0),
      a: 0.10 + 0.16 * Math.sin(af * Math.PI),
      paper: ai % 3 !== 0
    });
  }

  function buildCelestial(sky) {
    if (sky === 'saturn') {
      celestialSpec = {
        moons: [
          { a: 1.56, inc: 0.04, speed: 0.16, ph: 0.4, r: 2.0, tone: 'paper' },
          { a: 1.72, inc: -0.06, speed: 0.11, ph: 2.5, r: 1.6, tone: 'amber' }
        ]
      };
    } else if (sky === 'neptune') {
      celestialSpec = {
        moons: [
          { a: 1.48, inc: 0.14, speed: -0.18, ph: 1.1, r: 2.2, tone: 'paper' },
          { a: 1.68, inc: -0.04, speed: 0.12, ph: 4.0, r: 1.4, tone: 'amber' }
        ]
      };
    } else if (sky === 'blackhole') {
      celestialSpec = {
        moons: [
          { a: 1.55, inc: 0.12, speed: 0.32, ph: 0.8, r: 1.6, tone: 'flare' }
        ]
      };
    } else {
      celestialSpec = {
        moons: [
          { a: 1.48, inc: -0.09, speed: 0.14, ph: 1.9, r: 1.9, tone: 'paper' }
        ]
      };
    }
  }

  window.__wsRebuildCelestial = buildCelestial;
  buildCelestial(currentSky);

  var lastPtrMove = performance.now();
  window.addEventListener('pointermove', function (e) {
    ptrX = (e.clientX / Math.max(1, window.innerWidth) - 0.5) * 2;
    ptrY = (e.clientY / Math.max(1, window.innerHeight) - 0.5) * 2;
    lastPtrMove = performance.now();
  }, { passive: true });

  var stagePtr = null;
  var nearestCanvasIdx = -1;
  if (horbit) {
    horbit.addEventListener('pointermove', function (e) {
      var r = horbit.getBoundingClientRect();
      stagePtr = { x: e.clientX - r.left, y: e.clientY - r.top };
    });
    horbit.addEventListener('pointerleave', function () {
      stagePtr = null;
      hoveredZoneIdx = -1;
      nearestCanvasIdx = -1;
    });
  }
  if (ptCanvas) {
    ptCanvas.addEventListener('click', function () {
      if (nearestCanvasIdx >= 0 && order[nearestCanvasIdx]) {
        showZone(order[nearestCanvasIdx], true);
      }
    });
  }

  function resizeCanvases() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (bgCanvas) {
      bgCanvas.width = Math.floor(window.innerWidth * dpr);
      bgCanvas.height = Math.floor(window.innerHeight * dpr);
      if (bgCtx) bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    if (ptCanvas && horbit) {
      var r = horbit.getBoundingClientRect();
      ptCanvas.width = Math.max(1, Math.floor(r.width * dpr));
      ptCanvas.height = Math.max(1, Math.floor(r.height * dpr));
      if (ptCtx) ptCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  var resizeFrame = 0;
  window.__wsRedraw = function () {
    if (!reduceMotion || resizeFrame) return;
    resizeFrame = requestAnimationFrame(function (now) { resizeFrame = 0; renderFrame(now); });
  };
  window.addEventListener('resize', function () { resizeCanvases(); window.__wsRedraw(); });
  window.addEventListener('scroll', window.__wsRedraw, { passive: true });
  resizeCanvases();

  var rafId = 0;
  var prevTime = performance.now();
  var cometTimer = 1.8;

  function rgb(arr, alpha) {
    return 'rgba(' + arr[0] + ',' + arr[1] + ',' + arr[2] + ',' + alpha.toFixed(3) + ')';
  }

  function renderFrame(now) {
    var dt = Math.min(0.05, Math.max(0.001, (now - prevTime) / 1000));
    prevTime = now;
    var tSec = now / 1000;
    var sky = SKIES[currentSky] || SKIES.saturn;

    smPtrX += (ptrX - smPtrX) * (reduceMotion ? 1 : 0.06);
    smPtrY += (ptrY - smPtrY) * (reduceMotion ? 1 : 0.06);

    /* 1. Render Ambient Starfield + Comets */
    if (bgCtx && bgCanvas) {
      var bw = window.innerWidth;
      var bh = window.innerHeight;
      bgCtx.clearRect(0, 0, bw, bh);

      for (var i = 0; i < bgStars.length; i++) {
        var st = bgStars[i];
        var sx = st.x * bw - smPtrX * st.z * 18;
        var sy = st.y * bh - smPtrY * st.z * 14;
        var tw = reduceMotion ? 0.6 : (0.35 + 0.55 * (0.5 + 0.5 * Math.sin(tSec * st.sp + st.ph)));
        bgCtx.fillStyle = rgb(st.warm ? sky.amber : sky.paper, tw * (0.28 + st.z * 0.45));
        bgCtx.beginPath();
        bgCtx.arc(sx, sy, st.r, 0, Math.PI * 2);
        bgCtx.fill();
      }

      if (!reduceMotion) {
        cometTimer -= dt;
        if (cometTimer <= 0) {
          spawnComet(bw, bh);
          cometTimer = 3.8 + Math.random() * 5.2;
        }
        for (var ci = comets.length - 1; ci >= 0; ci--) {
          var cm = comets[ci];
          cm.life += dt;
          if (cm.life >= cm.max) {
            comets.splice(ci, 1);
            continue;
          }
          cm.x += cm.vx * dt;
          cm.y += cm.vy * dt;
          var p = cm.life / cm.max;
          var alpha = Math.sin(p * Math.PI) * 0.72;
          var tx = cm.x - cm.vx * 0.14;
          var ty = cm.y - cm.vy * 0.14;
          var grad = bgCtx.createLinearGradient(cm.x, cm.y, tx, ty);
          grad.addColorStop(0, rgb(sky.amber, alpha));
          grad.addColorStop(1, rgb(sky.amber, 0));
          bgCtx.strokeStyle = grad;
          bgCtx.lineWidth = 1.4;
          bgCtx.beginPath();
          bgCtx.moveTo(cm.x, cm.y);
          bgCtx.lineTo(tx, ty);
          bgCtx.stroke();
        }
      }
    }

    /* 2. Render Hero 3D Celestial Particles & Orbital Nodes */
    var heroRect = horbit ? horbit.getBoundingClientRect() : null;
    if (ptCtx && heroRect && heroRect.bottom > 0 && heroRect.top < window.innerHeight) {
      var rect = heroRect;
      var pw = rect.width;
      var ph = rect.height;
      var wide = pw >= 980;
      var cx = wide ? pw * 0.36 : pw * 0.5;
      var cy = ph * 0.53;
      var scale = Math.min(pw, ph) * (wide ? 0.34 : 0.36);
      var fov = 3.8;

      ptCtx.clearRect(0, 0, pw, ph);

      // Spin around planet's polar Y axis FIRST, then tilt pitch toward viewer & roll -12 deg
      var spinY = reduceMotion ? 0 : tSec * 0.08;
      var pitch = 0.40 + smPtrY * 0.10;
      var roll = -0.20 + smPtrX * 0.06;
      var cosS = Math.cos(spinY), sinS = Math.sin(spinY);
      var cosP = Math.cos(pitch), sinP = Math.sin(pitch);
      var cosR = Math.cos(roll), sinR = Math.sin(roll);

      // Soft planetary aura behind everything
      var auraR = scale * 1.6;
      var aura = ptCtx.createRadialGradient(cx, cy, scale * 0.18, cx, cy, auraR);
      aura.addColorStop(0, rgb(sky.amber, currentSky === 'blackhole' ? 0.12 : 0.18));
      aura.addColorStop(0.45, rgb(sky.amber, 0.06));
      aura.addColorStop(1, rgb(sky.amber, 0));
      ptCtx.fillStyle = aura;
      ptCtx.beginPath();
      ptCtx.arc(cx, cy, auraR, 0, Math.PI * 2);
      ptCtx.fill();

      // Subtle outer constellation ellipse passing through the 6 cabin nodes
      ptCtx.save();
      ptCtx.setLineDash([2, 6]);
      ptCtx.strokeStyle = rgb(sky.paper, 0.13);
      ptCtx.lineWidth = 1;
      ptCtx.beginPath();
      ptCtx.ellipse(cx, cy, scale * 1.96, scale * 0.94, -0.06, 0, Math.PI * 2);
      ptCtx.stroke();
      ptCtx.restore();

      var coreRadius = currentSky === 'blackhole' ? 0.44 : (currentSky === 'neptune' ? 0.56 : (currentSky === 'betelgeuse' ? 0.58 : 0.53));
      var coreYScale = currentSky === 'saturn' ? 0.91 : 0.98;
      var ringTilt = roll;
      var ringSinP = Math.max(0.24, Math.abs(Math.sin(pitch)));

      // Project a 3D point in planet-local coordinates through spin -> pitch -> roll
      function proj3(px0, py0, pz0, noSpin) {
        var x1 = noSpin ? px0 : (px0 * cosS - pz0 * sinS);
        var z1 = noSpin ? pz0 : (px0 * sinS + pz0 * cosS);
        var y2 = py0 * cosP - z1 * sinP;
        var z2 = py0 * sinP + z1 * cosP;
        var rx = x1 * cosR - y2 * sinR;
        var ry = x1 * sinR + y2 * cosR;
        var persp = fov / (fov + z2);
        return { x: cx + rx * scale * persp, y: cy + ry * scale * persp, rx: rx, ry: ry, rz: z2 };
      }

      // Draw orbital arcs/rings in two Z-ordered halves (back behind globe, front in front of globe)
      function drawRingsHalf(isFront) {
        if (currentSky === 'betelgeuse') {
          if (isFront) return;
          // Soft concentric dust shells around Betelgeuse supergiant
          ptCtx.save();
          ptCtx.translate(cx, cy);
          for (var sh = 0; sh < 3; sh++) {
            var sr = scale * (0.86 + sh * 0.22);
            ptCtx.strokeStyle = rgb(sh === 0 ? sky.flare : sky.paper, 0.08 - sh * 0.02);
            ptCtx.lineWidth = 1.2;
            ptCtx.beginPath();
            ptCtx.arc(0, 0, sr, 0, Math.PI * 2);
            ptCtx.stroke();
          }
          ptCtx.restore();
          return;
        }

        ptCtx.save();
        ptCtx.translate(cx, cy);
        ptCtx.rotate(ringTilt);
        ptCtx.beginPath();
        if (isFront) ptCtx.rect(-scale * 2.4, -0.5, scale * 4.8, scale * 2.4);
        else ptCtx.rect(-scale * 2.4, -scale * 2.4, scale * 4.8, scale * 2.4 + 0.5);
        ptCtx.clip();

        var sideMult = isFront ? 1.0 : 0.72;

        if (currentSky === 'saturn') {
          // C ring faint translucent inner veil
          ptCtx.strokeStyle = rgb(sky.amber, 0.08 * sideMult);
          ptCtx.lineWidth = scale * 0.11;
          ptCtx.beginPath();
          ptCtx.ellipse(0, 0, scale * 0.72, scale * 0.72 * ringSinP, 0, 0, Math.PI * 2);
          ptCtx.stroke();

          // B ring warm champagne sheen
          ptCtx.strokeStyle = rgb(sky.amber, 0.18 * sideMult);
          ptCtx.lineWidth = scale * 0.28;
          ptCtx.beginPath();
          ptCtx.ellipse(0, 0, scale * 0.92, scale * 0.92 * ringSinP, 0, 0, Math.PI * 2);
          ptCtx.stroke();

          // A ring cool ivory-gold sheen (clean Cassini gap between 1.06 and 1.13)
          ptCtx.strokeStyle = rgb(sky.paper, 0.12 * sideMult);
          ptCtx.lineWidth = scale * 0.21;
          ptCtx.beginPath();
          ptCtx.ellipse(0, 0, scale * 1.235, scale * 1.235 * ringSinP, 0, 0, Math.PI * 2);
          ptCtx.stroke();

          // Silky brushed concentric micro-ringlets (B ring)
          for (var bi = 0; bi < SATURN_BRINGS.length; bi++) {
            var br = SATURN_BRINGS[bi];
            ptCtx.strokeStyle = rgb(br.paper ? sky.paper : sky.amber, br.a * sideMult);
            ptCtx.lineWidth = br.w;
            ptCtx.beginPath();
            ptCtx.ellipse(0, 0, scale * br.r, scale * br.r * ringSinP, 0, 0, Math.PI * 2);
            ptCtx.stroke();
          }

          // Silky brushed concentric micro-ringlets (A ring outside Cassini Division)
          for (var ai2 = 0; ai2 < SATURN_ARINGS.length; ai2++) {
            var ar = SATURN_ARINGS[ai2];
            ptCtx.strokeStyle = rgb(ar.paper ? sky.paper : sky.amber, ar.a * sideMult);
            ptCtx.lineWidth = ar.w;
            ptCtx.beginPath();
            ptCtx.ellipse(0, 0, scale * ar.r, scale * ar.r * ringSinP, 0, 0, Math.PI * 2);
            ptCtx.stroke();
          }

          // Razor-sharp outer F-ring hairline
          ptCtx.strokeStyle = rgb(sky.paper, 0.28 * sideMult);
          ptCtx.lineWidth = 0.85;
          ptCtx.beginPath();
          ptCtx.ellipse(0, 0, scale * 1.38, scale * 1.38 * ringSinP, 0, 0, Math.PI * 2);
          ptCtx.stroke();

          // Subtle planetary shadow cast onto back-right limb of rings (clipped strictly inside ring envelope)
          if (!isFront) {
            ptCtx.save();
            ptCtx.beginPath();
            ptCtx.ellipse(0, 0, scale * 1.38, scale * 1.38 * ringSinP, 0, 0, Math.PI * 2);
            ptCtx.clip();
            var shGrad = ptCtx.createLinearGradient(scale * 0.10, 0, scale * 1.10, -scale * 0.55);
            shGrad.addColorStop(0, 'rgba(10, 10, 12, 0.82)');
            shGrad.addColorStop(0.55, 'rgba(10, 10, 12, 0.42)');
            shGrad.addColorStop(1, 'rgba(10, 10, 12, 0)');
            ptCtx.fillStyle = shGrad;
            ptCtx.beginPath();
            ptCtx.moveTo(scale * 0.08, 0);
            ptCtx.lineTo(scale * 1.48, -scale * 0.52);
            ptCtx.lineTo(scale * 0.32, -scale * 0.72);
            ptCtx.closePath();
            ptCtx.fill();
            ptCtx.restore();
          }
        } else if (currentSky === 'neptune') {
          // Le Verrier & Adams gossamer ice ringlets
          var nepRings = [0.95, 1.24];
          for (var nr = 0; nr < nepRings.length; nr++) {
            ptCtx.strokeStyle = rgb(sky.amber, (nr === 1 ? 0.26 : 0.18) * sideMult);
            ptCtx.lineWidth = nr === 1 ? 1.2 : 0.9;
            ptCtx.beginPath();
            ptCtx.ellipse(0, 0, scale * nepRings[nr], scale * nepRings[nr] * ringSinP, 0, 0, Math.PI * 2);
            ptCtx.stroke();
          }
          // Broken Adams ring luminous arcs rotating smoothly
          var nepArcs = [[0.2, 0.9], [1.6, 2.3], [3.3, 4.1], [4.9, 5.6]];
          var arcSpin = reduceMotion ? 0 : tSec * 0.08;
          ptCtx.strokeStyle = rgb(sky.paper, 0.55 * sideMult);
          ptCtx.lineWidth = 2.0;
          ptCtx.lineCap = 'round';
          for (var na = 0; na < nepArcs.length; na++) {
            ptCtx.beginPath();
            ptCtx.ellipse(0, 0, scale * 1.24, scale * 1.24 * ringSinP, 0, nepArcs[na][0] + arcSpin, nepArcs[na][1] + arcSpin);
            ptCtx.stroke();
          }
        } else if (currentSky === 'blackhole') {
          // Relativistic feathered accretion disk with Doppler brightening on approaching left limb
          var dopplerGrad = ptCtx.createLinearGradient(-scale * 1.38, 0, scale * 1.38, 0);
          dopplerGrad.addColorStop(0, rgb(sky.paper, 0.65 * sideMult));
          dopplerGrad.addColorStop(0.45, rgb(sky.amber, 0.42 * sideMult));
          dopplerGrad.addColorStop(1, rgb(sky.flare, 0.16 * sideMult));

          for (var bhi = 0; bhi < 26; bhi++) {
            var bhf = bhi / 25;
            var bhr = 0.55 + bhf * 0.85;
            var env = Math.sin(bhf * Math.PI);
            ptCtx.strokeStyle = dopplerGrad;
            ptCtx.globalAlpha = (0.14 + env * 0.42) * sideMult;
            ptCtx.lineWidth = 2.2 - bhf * 1.1;
            ptCtx.beginPath();
            ptCtx.ellipse(0, 0, scale * bhr, scale * bhr * ringSinP, 0, 0, Math.PI * 2);
            ptCtx.stroke();
          }
          ptCtx.globalAlpha = 1;
        }

        ptCtx.restore();
      }

      // Draw tiny clean orbital shepherd moons (only moons behind/front at subtle Keplerian orbits)
      function drawMoons(wantFront) {
        var moons = celestialSpec.moons || [];
        for (var mi = 0; mi < moons.length; mi++) {
          var m = moons[mi];
          var ma = m.ph + (reduceMotion ? 0 : tSec * m.speed);
          var mp = proj3(Math.cos(ma) * m.a, Math.sin(ma) * Math.sin(m.inc) * m.a, Math.sin(ma) * m.a, true);
          var isBehind = mp.rz > 0;
          if (wantFront === isBehind) continue;
          if (isBehind && Math.hypot(mp.rx / coreRadius, mp.ry / (coreRadius * coreYScale)) <= 1.02) continue;

          var mc = m.tone === 'amber' ? sky.amber : (m.tone === 'flare' ? sky.flare : sky.paper);
          var mg = ptCtx.createRadialGradient(mp.x, mp.y, 0, mp.x, mp.y, m.r * 3.8);
          mg.addColorStop(0, rgb(mc, 0.45));
          mg.addColorStop(1, rgb(mc, 0));
          ptCtx.fillStyle = mg;
          ptCtx.beginPath();
          ptCtx.arc(mp.x, mp.y, m.r * 3.8, 0, Math.PI * 2);
          ptCtx.fill();

          ptCtx.fillStyle = rgb(mc, 0.92);
          ptCtx.beginPath();
          ptCtx.arc(mp.x, mp.y, m.r, 0, Math.PI * 2);
          ptCtx.fill();
        }
      }

      // 1) Back-side rings & back moons
      drawRingsHalf(false);
      drawMoons(false);

      // 2) Luminous volumetric 3D globe + silky latitude flow curves (zero dot blobs!)
      ptCtx.save();
      ptCtx.beginPath();
      ptCtx.ellipse(cx, cy, scale * coreRadius, scale * coreRadius * coreYScale, roll, 0, Math.PI * 2);

      if (currentSky === 'blackhole') {
        // Gravitational lensed upper/lower Einstein arc halo around the shadow
        ptCtx.restore();
        ptCtx.save();
        var ehR = scale * coreRadius;
        var lensG = ptCtx.createRadialGradient(cx, cy, ehR * 0.96, cx, cy, ehR * 1.28);
        lensG.addColorStop(0, rgb(sky.paper, 0.72));
        lensG.addColorStop(0.22, rgb(sky.amber, 0.42));
        lensG.addColorStop(0.65, rgb(sky.flare, 0.14));
        lensG.addColorStop(1, rgb(sky.amber, 0));
        ptCtx.fillStyle = lensG;
        ptCtx.beginPath();
        ptCtx.arc(cx, cy, ehR * 1.28, 0, Math.PI * 2);
        ptCtx.fill();

        // Crisp pitch-black Event Horizon + photon ring rim
        ptCtx.fillStyle = '#020204';
        ptCtx.beginPath();
        ptCtx.arc(cx, cy, ehR, 0, Math.PI * 2);
        ptCtx.fill();
        ptCtx.strokeStyle = rgb(sky.paper, 0.72);
        ptCtx.lineWidth = 1.6;
        ptCtx.stroke();
        ptCtx.restore();
      } else {
        // Volumetric sunlit 3D sphere shading from upper-left
        var lx = cx - scale * coreRadius * 0.38;
        var ly = cy - scale * coreRadius * 0.38;
        var sg = ptCtx.createRadialGradient(lx, ly, scale * 0.04, cx, cy, scale * coreRadius * 1.06);
        if (currentSky === 'saturn') {
          sg.addColorStop(0, 'rgba(246, 229, 192, 0.62)');
          sg.addColorStop(0.36, 'rgba(216, 172, 102, 0.38)');
          sg.addColorStop(0.74, 'rgba(84, 62, 36, 0.22)');
          sg.addColorStop(1, 'rgba(10, 10, 12, 0.96)');
        } else if (currentSky === 'neptune') {
          sg.addColorStop(0, 'rgba(196, 228, 255, 0.60)');
          sg.addColorStop(0.40, 'rgba(92, 152, 224, 0.36)');
          sg.addColorStop(0.76, 'rgba(26, 54, 96, 0.24)');
          sg.addColorStop(1, 'rgba(7, 9, 13, 0.96)');
        } else {
          sg.addColorStop(0, 'rgba(255, 220, 186, 0.68)');
          sg.addColorStop(0.42, 'rgba(216, 106, 74, 0.42)');
          sg.addColorStop(0.80, 'rgba(104, 32, 28, 0.26)');
          sg.addColorStop(1, 'rgba(12, 10, 10, 0.94)');
        }
        ptCtx.fillStyle = sky.ground;
        ptCtx.fill();
        ptCtx.fillStyle = sg;
        ptCtx.fill();

        // Clip inside sphere for silky brushed latitude flow curves & polar hexagon
        ptCtx.save();
        ptCtx.clip();

        var latRows = currentSky === 'saturn' ? 22 : 18;
        var segs = 44;
        ptCtx.lineCap = 'round';
        for (var rowIdx = 0; rowIdx < latRows; rowIdx++) {
          var uLat = -0.86 + (rowIdx / (latRows - 1)) * 1.72;
          var rLat = Math.sqrt(Math.max(0, 1 - uLat * uLat)) * coreRadius;
          var yLat = uLat * coreRadius * coreYScale;
          var bandWave = Math.sin(uLat * 9.5 + 0.4) * 0.5 + 0.5;
          var isAmberBand = currentSky === 'betelgeuse' ? (rowIdx % 2 === 0) : (bandWave > 0.46);
          var prevPt = null;

          for (var sIdx = 0; sIdx <= segs; sIdx++) {
            var th = (sIdx / segs) * Math.PI * 2;
            var swell = currentSky === 'betelgeuse'
              ? Math.sin(th * 3 + tSec * 0.8 + rowIdx) * 0.022
              : Math.sin(th * 2 + uLat * 4) * 0.008;
            var p3 = proj3(rLat * Math.cos(th), yLat + swell, rLat * Math.sin(th), false);
            if (p3.rz <= 0.04) {
              if (prevPt) {
                var limb = Math.max(0, Math.min(1, (-p3.rz + 0.04) * 3.2));
                var lit = Math.max(0.18, Math.min(1, 0.72 - p3.rx * 0.45 - p3.ry * 0.45));
                var strokeA = (0.14 + bandWave * 0.34) * limb * lit;
                ptCtx.strokeStyle = rgb(isAmberBand ? sky.amber : sky.paper, strokeA);
                ptCtx.lineWidth = 0.85 + bandWave * 0.95;
                ptCtx.beginPath();
                ptCtx.moveTo(prevPt.x, prevPt.y);
                ptCtx.lineTo(p3.x, p3.y);
                ptCtx.stroke();
              }
              prevPt = p3;
            } else {
              prevPt = null;
            }
          }
        }

        // Saturn iconic north-polar hexagonal vortex
        if (currentSky === 'saturn') {
          var hexR = coreRadius * Math.sin(0.24);
          var hexY = -coreRadius * Math.cos(0.24) * coreYScale;
          ptCtx.strokeStyle = rgb(sky.paper, 0.34);
          ptCtx.lineWidth = 1.05;
          ptCtx.beginPath();
          for (var hx = 0; hx <= 6; hx++) {
            var ha = (hx / 6) * Math.PI * 2;
            var hp = proj3(hexR * Math.cos(ha), hexY, hexR * Math.sin(ha), false);
            if (hx === 0) ptCtx.moveTo(hp.x, hp.y);
            else ptCtx.lineTo(hp.x, hp.y);
          }
          ptCtx.stroke();
        } else if (currentSky === 'neptune') {
          // Great Dark Spot + subtle companion streak
          var gds = proj3(-coreRadius * 0.25, coreRadius * 0.22, -coreRadius * 0.88, false);
          if (gds.rz < 0) {
            ptCtx.fillStyle = 'rgba(14, 28, 56, 0.55)';
            ptCtx.beginPath();
            ptCtx.ellipse(gds.x, gds.y, scale * 0.085, scale * 0.048, roll, 0, Math.PI * 2);
            ptCtx.fill();
            ptCtx.strokeStyle = rgb(sky.paper, 0.32);
            ptCtx.lineWidth = 0.9;
            ptCtx.beginPath();
            ptCtx.moveTo(gds.x - scale * 0.09, gds.y + scale * 0.04);
            ptCtx.lineTo(gds.x + scale * 0.06, gds.y + scale * 0.04);
            ptCtx.stroke();
          }
        }

        // Smooth upper-left specular atmospheric bloom + lower-right night terminator
        var termG = ptCtx.createLinearGradient(
          cx - scale * coreRadius * 0.7, cy - scale * coreRadius * 0.7,
          cx + scale * coreRadius * 0.85, cy + scale * coreRadius * 0.85
        );
        termG.addColorStop(0, 'rgba(255, 250, 238, 0.08)');
        termG.addColorStop(0.55, 'rgba(0, 0, 0, 0)');
        termG.addColorStop(1, 'rgba(4, 4, 6, 0.62)');
        ptCtx.fillStyle = termG;
        ptCtx.fillRect(cx - scale * 0.8, cy - scale * 0.8, scale * 1.6, scale * 1.6);

        ptCtx.restore();

        // Crisp sunlit atmospheric crescent rim
        var rimG = ptCtx.createLinearGradient(
          cx - scale * coreRadius, cy - scale * coreRadius,
          cx + scale * coreRadius, cy + scale * coreRadius
        );
        rimG.addColorStop(0, rgb(sky.paper, 0.42));
        rimG.addColorStop(0.55, rgb(sky.amber, 0.16));
        rimG.addColorStop(1, rgb(sky.amber, 0.03));
        ptCtx.strokeStyle = rimG;
        ptCtx.lineWidth = 1.25;
        ptCtx.beginPath();
        ptCtx.ellipse(cx, cy, scale * coreRadius, scale * coreRadius * coreYScale, roll, 0, Math.PI * 2);
        ptCtx.stroke();

        ptCtx.restore();
      }

      // 3) Front-side brushed rings & front moons
      drawRingsHalf(true);
      drawMoons(true);

      // Compute 2D positions of 6 orbital cabin nodes cleanly outside the rings
      var nodePos = [];
      for (var ni = 0; ni < ORBIT_NODES.length; ni++) {
        var nd = ORBIT_NODES[ni];
        var ang = nd.angle + (reduceMotion ? 0 : Math.sin(tSec * 0.25 + ni) * 0.035);
        var ox = Math.cos(ang) * nd.rx;
        var oy = Math.sin(ang) * nd.ry;
        // Apply -0.06 tilt + subtle mouse parallax
        var txo = ox * Math.cos(-0.06) - oy * Math.sin(-0.06);
        var tyo = ox * Math.sin(-0.06) + oy * Math.cos(-0.06);
        nodePos.push({
          x: cx + txo * scale + smPtrX * 6,
          y: cy + tyo * scale + smPtrY * 4
        });
      }

      // Magnetic hover detection on canvas
      var nearestIdx = -1;
      if (stagePtr && wide) {
        var bestD = 76;
        for (var hi = 0; hi < nodePos.length; hi++) {
          var dist = Math.hypot(nodePos[hi].x - stagePtr.x, nodePos[hi].y - stagePtr.y);
          if (dist < bestD) {
            bestD = dist;
            nearestIdx = hi;
          }
        }
      }
      nearestCanvasIdx = nearestIdx;
      if (ptCanvas) ptCanvas.style.cursor = nearestIdx >= 0 ? 'pointer' : '';

      // Idle travelling beacon if no hover & idle > 2.4s
      var hintIdx = -1;
      if (hoveredZoneIdx < 0 && nearestIdx < 0 && !reduceMotion && (now - lastPtrMove > 2400)) {
        hintIdx = Math.floor(((now - lastPtrMove - 2400) / 3000)) % ORBIT_NODES.length;
      }

      var litIdx = hoveredZoneIdx >= 0 ? hoveredZoneIdx : (nearestIdx >= 0 ? nearestIdx : activeZoneIdx);

      // Update index hint classes
      indexRows.forEach(function (li, idx) {
        li.classList.toggle('is-hint', idx === hintIdx && idx !== litIdx);
      });

      // Draw orbital nodes + radial labels
      for (var di = 0; di < nodePos.length; di++) {
        var p2 = nodePos[di];
        var isLit = di === litIdx;
        var isHint = di === hintIdx && !isLit;

        if (isLit || isHint) {
          var glowR = isLit ? 20 : 14;
          var rg = ptCtx.createRadialGradient(p2.x, p2.y, 0, p2.x, p2.y, glowR);
          rg.addColorStop(0, rgb(sky.amber, isLit ? 0.55 : 0.3));
          rg.addColorStop(1, rgb(sky.amber, 0));
          ptCtx.fillStyle = rg;
          ptCtx.beginPath();
          ptCtx.arc(p2.x, p2.y, glowR, 0, Math.PI * 2);
          ptCtx.fill();

          ptCtx.strokeStyle = rgb(sky.amber, isLit ? 0.78 : 0.4);
          ptCtx.lineWidth = 1;
          ptCtx.beginPath();
          ptCtx.arc(p2.x, p2.y, isLit ? 9 : 7, 0, Math.PI * 2);
          ptCtx.stroke();
        }

        ptCtx.fillStyle = isLit ? rgb(sky.amber, 0.98) : (isHint ? rgb(sky.amber, 0.75) : rgb(sky.paper, 0.55));
        ptCtx.beginPath();
        ptCtx.arc(p2.x, p2.y, isLit ? 3.2 : 2.1, 0, Math.PI * 2);
        ptCtx.fill();

        // Sync floating DOM labels on wide viewports
        if (wide && orbitLabels[di] && orbitTags[di]) {
          var lbl = orbitLabels[di];
          var tag = orbitTags[di];
          var ux = p2.x - cx;
          var uy = (p2.y - cy) * 1.9;
          var ul = Math.hypot(ux, uy) || 1;
          ux /= ul;
          uy /= ul;

          var lw = lbl.offsetWidth || 160;
          var lh = lbl.offsetHeight || 56;
          var lx = p2.x + ux * 20 - lw * (0.5 - 0.5 * ux);
          var ly = p2.y + uy * 14 - lh * (0.5 - 0.5 * uy);
          lx = Math.max(24, Math.min(pw - lw - 330, lx));
          ly = Math.max(76, Math.min(ph - lh - 20, ly));

          lbl.style.transform = 'translate3d(' + lx.toFixed(1) + 'px,' + ly.toFixed(1) + 'px,0)';
          lbl.style.opacity = isLit ? '1' : (isHint ? '0.88' : '0');
          lbl.classList.toggle('is-on', isLit);
          lbl.classList.toggle('is-hint', isHint);

          var tw = tag.offsetWidth || 40;
          var th = tag.offsetHeight || 20;
          var tx2 = Math.max(16, Math.min(pw - tw - 330, p2.x + ux * 10 - tw * (0.5 - 0.5 * ux)));
          var ty2 = Math.max(70, Math.min(ph - th - 12, p2.y + uy * 8 - th * (0.5 - 0.5 * uy)));
          tag.style.transform = 'translate3d(' + tx2.toFixed(1) + 'px,' + ty2.toFixed(1) + 'px,0)';
          tag.style.opacity = (isLit || isHint) ? '0' : '0.78';
          tag.classList.toggle('is-on', isLit);

          if (isLit || isHint) {
            ptCtx.strokeStyle = rgb(sky.amber, isLit ? 0.36 : 0.2);
            ptCtx.lineWidth = 1;
            ptCtx.beginPath();
            ptCtx.moveTo(p2.x, p2.y);
            ptCtx.lineTo(lx + lw * 0.5, ly + lh * 0.5);
            ptCtx.stroke();
          }
        }
      }
    }

    if (!reduceMotion && !document.hidden) {
      rafId = requestAnimationFrame(renderFrame);
    }
  }

  function startLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    prevTime = performance.now();
    if (reduceMotion) {
      renderFrame(prevTime);
    } else if (!document.hidden) {
      rafId = requestAnimationFrame(renderFrame);
    }
  }

  document.addEventListener('visibilitychange', function () {
    document.body.classList.toggle('is-hidden', document.hidden);
    if (metEl) syncMet();
    if (document.hidden) {
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    } else {
      startLoop();
      if (qChips && (Date.now() - qFetchedAt > 4000)) loadQuota(false);
    }
  });

  startLoop();
})();
