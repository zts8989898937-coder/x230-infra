<?php
declare(strict_types=1);
// 私人工作区入口。只有持有口令链接（?k=）的浏览器能拿到签名 cookie，其余一律 403。
// 前端 portal 通过 status.php 读取授权状态，决定 WORKSPACE 星体显示“可进入”还是“无权限访问”。
require __DIR__ . '/lib.php';

sf_ws_headers();

$secret = sf_ws_secret();

if (isset($_GET['out'])) {
    setcookie(SF_WS_COOKIE, '', [
        'expires' => time() - 3600,
        'path' => '/workspace/',
        'secure' => true,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    header('Location: /workspace/', true, 302);
    exit;
}

if (isset($_GET['k'])) {
    $token = (string) ($secret['token'] ?? '');
    $given = (string) $_GET['k'];
    if ($token !== '' && strlen($given) === strlen($token) && hash_equals($token, $given)) {
        setcookie(SF_WS_COOKIE, sf_ws_grant(), [
            'expires' => time() + SF_WS_TTL,
            'path' => '/workspace/',
            'secure' => true,
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
        // 立刻把口令从地址栏抹掉：任何截图、历史记录、referer 都不该带上它。
        header('Location: /workspace/', true, 302);
        exit;
    }
    http_response_code(403);
    echo sf_ws_shell('NO ACCESS — Still Floating', 'WORKSPACE / PRIVATE', <<<'HTML'
        <div class="denied">
          <span class="stamp">KEY REJECTED / 口令无效</span>
          <h1>口令已失效</h1>
          <p>换一条链接，或者用口令进入。</p>
          <a class="back" href="/">← 回到入口</a>
        </div>
        HTML);
    exit;
}

// 口令登录：本人换设备时不用翻聊天记录里的长链接。
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    $pass = (string) ($secret['pass'] ?? '');
    $given = (string) ($_POST['pw'] ?? '');
    $ok = $pass !== '' && strlen($given) <= 200 && sf_ws_rate_ok() && hash_equals($pass, $given);
    if ($ok) {
        sf_ws_clear_failures();
        setcookie(SF_WS_COOKIE, sf_ws_grant(), [
            'expires' => time() + SF_WS_TTL,
            'path' => '/workspace/',
            'secure' => true,
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
        header('Location: /workspace/', true, 302);
        exit;
    }
    sf_ws_note_failure();
    http_response_code(403);
    echo sf_ws_shell('NO PERMISSION — Still Floating', 'WORKSPACE / PRIVATE', <<<'HTML'
        <div class="denied">
          <span class="stamp">WRONG KEY / 口令不对</span>
          <h1>口令不对</h1>
          <p>再输一次；连续错 8 次锁 10 分钟。</p>
          <form method="post" class="gate">
            <input type="password" name="pw" autocomplete="current-password" placeholder="PASSPHRASE / 口令" aria-label="工作区口令" autofocus>
            <button type="submit">ENTER / 进入</button>
          </form>
          <a class="back" href="/">← 回到入口</a>
        </div>
        HTML);
    exit;
}

// CLI 预览开关：SF_WS_PREVIEW=1 时跳过授权检查，本地直接渲染整页用于截图。
// HTTP 请求拿不到这个环境变量，线上不受影响。
$preview = PHP_SAPI === 'cli' && getenv('SF_WS_PREVIEW') === '1';

if (!$preview && !sf_ws_authorized()) {
    http_response_code(403);
    echo sf_ws_shell('NO PERMISSION — Still Floating', 'WORKSPACE / PRIVATE', <<<'HTML'
        <div class="denied">
          <span class="stamp">NO PERMISSION / 无权限访问</span>
          <h1>私人工作区</h1>
          <p>需要口令。</p>
          <form method="post" class="gate">
            <input type="password" name="pw" autocomplete="current-password" placeholder="PASSPHRASE / 口令" aria-label="工作区口令">
            <button type="submit">ENTER / 进入</button>
          </form>
          <a class="back" href="/">← 回到入口</a>
        </div>
        HTML);
    exit;
}


$codeUrl = (string) ($secret['code_url'] ?? 'https://dsh.stillfloating.top/code/');
$lan = 'http://192.168.8.120';

// 增删就改这里：一间舱 = 一组，一行 = 一个入口。id 要和 bay.svg 里的 data-zone 对上。
$groups = [
    [
        'id' => 'core', 'num' => '01', 'cn' => '屏幕', 'en' => 'CORE',
        'items' => [
            ['label' => 'DSH / 会话工作台', 'sub' => 'DEEPSEEK HARNESS', 'href' => 'https://dsh.stillfloating.top/', 'tag' => 'MAIN'],
            ['label' => 'VS Code / 远程编辑器', 'sub' => 'CODE SERVE-WEB', 'href' => $codeUrl, 'tag' => 'IDE'],
            ['label' => 'X230 终端 / 公网', 'sub' => 'term · 折叠对话', 'href' => sprintf('https://%s.156-239-8-225.sslip.io/', 'term'), 'tag' => 'PUBLIC'],
            ['label' => 'X230 终端 / 局域网', 'sub' => '192.168.8.120:3902 · webterm', 'href' => 'http://192.168.8.120:3902/', 'tag' => 'LAN'],
            ['label' => 'Gitea / 代码', 'sub' => 'git', 'href' => sprintf('https://%s.156-239-8-225.sslip.io/', 'git'), 'tag' => 'PUBLIC'],
            ['label' => 'GitHub / 代码', 'sub' => 'zts8989898937-coder', 'href' => 'https://github.com/zts8989898937-coder?tab=repositories', 'tag' => 'CLOUD'],
            ['label' => 'JupyterLab / 计算', 'sub' => 'jupyter', 'href' => sprintf('https://%s.156-239-8-225.sslip.io/', 'jupyter'), 'tag' => 'GATE'],
            ['label' => 'BLOG / 专属写作台', 'sub' => 'MUSIC & ALGO WRITER', 'href' => '/workspace/write/', 'tag' => 'MAIN'],
            ['label' => 'BLOG / 后台', 'sub' => 'WORDPRESS', 'href' => 'https://stillfloating.top/wp-admin/', 'tag' => 'PUBLIC'],
        ],
    ],
    [
        'id' => 'file', 'num' => '02', 'cn' => '硬盘', 'en' => 'FILE',
        'items' => [
            ['label' => 'File Browser / 文件', 'sub' => 'files', 'href' => sprintf('https://%s.156-239-8-225.sslip.io/', 'files'), 'tag' => 'PUBLIC'],
            ['label' => 'Alist / 网盘', 'sub' => 'alist', 'href' => sprintf('https://%s.156-239-8-225.sslip.io/', 'alist'), 'tag' => 'PUBLIC'],
            ['label' => 'Stirling PDF / 文档', 'sub' => 'pdf', 'href' => sprintf('https://%s.156-239-8-225.sslip.io/', 'pdf'), 'tag' => 'GATE'],
            ['label' => 'Google Drive / 云盘', 'sub' => '5 TB', 'href' => 'https://drive.google.com/drive/folders/1aJuS57ZQiVlLHx6USuJG6Z2w6Qipspek', 'tag' => 'CLOUD'],
        ],
    ],
    [
        'id' => 'note', 'num' => '03', 'cn' => '键盘', 'en' => 'NOTE',
        'items' => [
            ['label' => 'Memos / 备忘', 'sub' => 'memos', 'href' => sprintf('https://%s.156-239-8-225.sslip.io/', 'memos'), 'tag' => 'PUBLIC'],
            ['label' => 'Excalidraw / 白板', 'sub' => 'board', 'href' => sprintf('https://%s.156-239-8-225.sslip.io/', 'board'), 'tag' => 'GATE'],
            ['label' => 'draw.io / 图表', 'sub' => 'draw', 'href' => sprintf('https://%s.156-239-8-225.sslip.io/', 'draw'), 'tag' => 'GATE'],
        ],
    ],
    [
        'id' => 'feed', 'num' => '04', 'cn' => '读听看', 'en' => 'FEED',
        'items' => [
            ['label' => 'Miniflux / 订阅', 'sub' => 'rss', 'href' => sprintf('https://%s.156-239-8-225.sslip.io/', 'rss'), 'tag' => 'PUBLIC'],
            ['label' => 'Navidrome / 音乐', 'sub' => 'music', 'href' => sprintf('https://%s.156-239-8-225.sslip.io/', 'music'), 'tag' => 'PUBLIC'],
            ['label' => 'Jellyfin / 影音', 'sub' => 'video', 'href' => sprintf('https://%s.156-239-8-225.sslip.io/', 'video'), 'tag' => 'PUBLIC'],
        ],
    ],
    [
        'id' => 'watch', 'num' => '05', 'cn' => '风扇', 'en' => 'WATCH',
        'items' => [
            ['label' => 'Uptime Kuma / 监控', 'sub' => 'kuma', 'href' => sprintf('https://%s.156-239-8-225.sslip.io/', 'kuma'), 'tag' => 'PUBLIC'],
            ['label' => 'X230 状态 / 看板', 'sub' => ':3081', 'href' => $lan . ':3081/', 'tag' => 'LAN'],
            ['label' => 'Netdata / 指标', 'sub' => ':19999', 'href' => $lan . ':19999/', 'tag' => 'LAN'],
        ],
    ],
    [
        'id' => 'home', 'num' => '00', 'cn' => '老家', 'en' => 'REMOTE',
        'items' => [
            ['label' => '香港服务器', 'sub' => '156.239.8.225', 'href' => 'https://stillfloating.top/', 'tag' => 'PUBLIC'],
            ['label' => '备份 / 快照', 'sub' => '05-备份归档', 'href' => 'https://drive.google.com/drive/folders/1aJuS57ZQiVlLHx6USuJG6Z2w6Qipspek', 'tag' => 'CLOUD'],
        ],
    ],
];

$panels = '';
$orbitLabels = '';
$orbitTags = '';
$orbitIndex = '';
$chips = '';

foreach ($groups as $g) {
    $rows = '';
    $summaryNames = [];
    foreach ($g['items'] as $it) {
        $tag = (string) ($it['tag'] ?? '');
        $tagCls = 'tag';
        if ($tag === 'LAN') {
            $tagCls .= ' tag-lan';
        } elseif ($tag === 'GATE') {
            $tagCls .= ' tag-gate';
        } elseif ($tag === 'PUBLIC') {
            $tagCls .= ' tag-pub';
        }
        $search = strtolower($it['label'] . ' ' . $it['sub'] . ' ' . $it['href'] . ' ' . $tag . ' ' . $g['cn'] . ' ' . $g['en']);
        $rows .= '<a class="item" href="' . sf_ws_e($it['href']) . '" target="_blank" rel="noopener" data-search="' . sf_ws_e($search) . '">'
            . '<span class="it-label">' . sf_ws_e($it['label']) . '</span>'
            . '<span class="it-sub">' . sf_ws_e($it['sub']) . '</span>'
            . '<span class="' . $tagCls . '">' . sf_ws_e($tag) . '</span>'
            . '<span class="it-arr" aria-hidden="true">↗</span>'
            . '</a>';
        $shortName = trim(explode('/', $it['label'])[0]);
        if ($shortName !== '') {
            $summaryNames[] = $shortName;
        }
    }

    $summaryLine = implode(' · ', array_slice($summaryNames, 0, 3)) . (count($summaryNames) > 3 ? '…' : '');
    $countStr = count($g['items']) . ' 项';

    $panels .= '<section class="panel-sec" data-panel="' . sf_ws_e($g['id']) . '" data-num="' . sf_ws_e($g['num']) . '" data-en="' . sf_ws_e($g['en']) . '" data-count="' . count($g['items']) . '">'
        . '<header class="ph"><span class="ph-num">' . sf_ws_e($g['num']) . '</span>'
        . '<h2>' . sf_ws_e($g['cn']) . '</h2><span class="ph-en">' . sf_ws_e($g['en']) . '</span>'
        . '<span class="ph-count">' . sf_ws_e($countStr) . '</span></header>'
        . '<nav class="items" aria-label="' . sf_ws_e($g['cn']) . '">' . $rows . '</nav></section>';

    $orbitLabels .= '<button type="button" class="horbit-label" data-zone="' . sf_ws_e($g['id']) . '">'
        . '<span class="l1"><span class="zh">' . sf_ws_e($g['cn']) . '</span><span class="en">' . sf_ws_e($g['en']) . '</span></span>'
        . '<span class="line">' . sf_ws_e($summaryLine) . '</span>'
        . '<span class="n">' . sf_ws_e($countStr) . '</span>'
        . '</button>';

    $orbitTags .= '<button type="button" class="horbit-tag" data-zone="' . sf_ws_e($g['id']) . '" tabindex="-1" aria-hidden="true">'
        . sf_ws_e($g['num'] . ' ' . $g['en'])
        . '</button>';

    $orbitIndex .= '<li data-zone="' . sf_ws_e($g['id']) . '">'
        . '<button type="button" class="horbit-index-a">'
        . '<span class="no">' . sf_ws_e($g['num']) . '</span>'
        . '<span class="zh">' . sf_ws_e($g['cn']) . '</span>'
        . '<span class="en">' . sf_ws_e($g['en']) . '</span>'
        . '<span class="more"><span>'
        . '<span class="line">' . sf_ws_e($summaryLine) . '</span>'
        . '<span class="n">' . sf_ws_e($countStr) . '</span>'
        . '</span></span>'
        . '</button></li>';

    $chips .= '<button class="ws-chip" type="button" data-jump="' . sf_ws_e($g['id']) . '">'
        . '<span>' . sf_ws_e($g['num']) . '</span>' . sf_ws_e($g['cn']) . '</button>';
}
$chips .= '<button class="ws-chip" type="button" data-jump="all"><span>↺</span>全部</button>';
$totalItems = array_sum(array_map(static function ($g) { return count($g['items']); }, $groups));
$totalGroups = count($groups);
?>
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#0a0a0c">
<title>Workspace — Still Floating</title>
<script>(function(){try{var t=localStorage.getItem('sf-ws-sky');if(t==='neptune'||t==='blackhole'||t==='betelgeuse')document.documentElement.setAttribute('data-theme',t);}catch(_){}})();</script>
<link rel="stylesheet" href="/workspace/ws.css?v=15">
</head>
<body>
<div id="boot" aria-hidden="true">
  <svg class="boot-svg" viewBox="-44 -44 88 88">
    <circle class="boot-ring" r="26"></circle>
    <circle class="boot-arc" r="26" transform="rotate(-90)"></circle>
    <circle class="boot-core" r="3"></circle>
  </svg>
</div>

<canvas id="cosmos-canvas" aria-hidden="true"></canvas>
<div class="cosmos-vignette" aria-hidden="true"></div>

<header class="snav" id="snav">
  <div class="snav-bar">
    <div class="snav-id">
      <a class="snav-name" href="/workspace/">Still Floating</a>
      <button type="button" class="snav-sky" id="snav-sky-btn" aria-expanded="false" aria-controls="snav-sky-drawer" title="切换天象主题">
        <svg class="sky-glyph" id="snav-sky-glyph" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="3.4"></circle>
          <ellipse cx="8" cy="8" rx="7" ry="2.3" transform="rotate(-14 8 8)"></ellipse>
        </svg>
        <span id="snav-sky-name">土星</span>
      </button>
    </div>

    <nav class="snav-row" id="snav-row" aria-label="工作区导航">
      <span class="snav-dot" id="snav-dot" aria-hidden="true"></span>
      <button type="button" id="snav-all-btn">全部舱</button>
      <button type="button" id="snav-search-btn">筛选<span class="snav-kbd">⌘K</span></button>
      <a href="/workspace/write/">写作</a>
      <a class="snav-row-blog" href="https://stillfloating.top/?sf_blog=1">博客</a>
      <a class="snav-row-home" href="/">入口</a>
      <a href="/workspace/?out=1">锁上</a>
      <button type="button" class="snav-fold-btn" id="snav-fold-btn" title="收起导航" aria-label="收起导航">×</button>
    </nav>

    <button type="button" class="snav-pin" id="snav-pin" title="展开导航" aria-label="展开导航"></button>
  </div>

  <div class="snav-more" id="snav-sky-drawer">
    <ul class="sky-list">
      <li>
        <button type="button" class="sky-opt is-active" data-sky="saturn">
          <span class="sky-opt-glyph"><svg class="sky-glyph" viewBox="0 0 16 16"><circle cx="8" cy="8" r="3.4"></circle><ellipse cx="8" cy="8" rx="7" ry="2.3" transform="rotate(-14 8 8)"></ellipse></svg></span>
          <span class="sky-opt-name">土星</span>
          <span class="sky-opt-desc">以冰为环，周行不息</span>
          <span class="sky-opt-en">SATURN</span>
        </button>
      </li>
      <li>
        <button type="button" class="sky-opt" data-sky="neptune">
          <span class="sky-opt-glyph"><svg class="sky-glyph" viewBox="0 0 16 16"><circle cx="8" cy="8" r="3.8"></circle><ellipse class="is-faint" cx="8" cy="8" rx="6.8" ry="2.1" transform="rotate(-14 8 8)"></ellipse></svg></span>
          <span class="sky-opt-name">海王星</span>
          <span class="sky-opt-desc">深海蓝环，静默远航</span>
          <span class="sky-opt-en">NEPTUNE</span>
        </button>
      </li>
      <li>
        <button type="button" class="sky-opt" data-sky="blackhole">
          <span class="sky-opt-glyph"><svg class="sky-glyph" viewBox="0 0 16 16"><circle class="is-solid" cx="8" cy="8" r="2.7"></circle><circle cx="8" cy="8" r="4.5"></circle><ellipse class="is-faint" cx="8" cy="8" rx="7.2" ry="1.8" transform="rotate(-8 8 8)"></ellipse></svg></span>
          <span class="sky-opt-name">黑洞</span>
          <span class="sky-opt-desc">事件视界，光亦折返</span>
          <span class="sky-opt-en">BLACK HOLE</span>
        </button>
      </li>
      <li>
        <button type="button" class="sky-opt" data-sky="betelgeuse">
          <span class="sky-opt-glyph"><svg class="sky-glyph" viewBox="0 0 16 16"><circle class="is-solid" cx="8" cy="8" r="3.2"></circle><circle class="is-faint" cx="8" cy="8" r="6.2"></circle></svg></span>
          <span class="sky-opt-name">参宿四</span>
          <span class="sky-opt-desc">红超巨星，余烬长明</span>
          <span class="sky-opt-en">BETELGEUSE</span>
        </button>
      </li>
    </ul>
  </div>
</header>

<main class="ws-main">
  <section class="horbit" id="horbit" aria-label="X230 星轨总览">
    <canvas id="pt-canvas" aria-hidden="true"></canvas>
    <nav class="horbit-labels" aria-label="星轨航点">
      <?= $orbitLabels ?>
      <?= $orbitTags ?>
    </nav>
    <ol class="horbit-index" aria-label="工作舱索引">
      <?= $orbitIndex ?>
    </ol>
  </section>

  <div class="ws-container">
    <section class="ws-mast">
      <h1 class="ws-mast-title">工作区<span>WORKSPACE BAY</span></h1>
      <div class="ws-mast-meta">
        <span>MISSION ELAPSED TIME · X230</span>
        <span class="ws-met" id="ws-met">-- 天 --:--:--</span>
        <b>●</b> <?= $totalGroups ?> 舱 · <?= $totalItems ?> 个入口
      </div>
    </section>

    <section class="ws-quota" id="ws-quota" aria-label="订阅与 API 额度">
      <div class="ws-quota-bar">
        <button type="button" class="ws-quota-toggle" id="ws-quota-toggle" aria-expanded="false" aria-controls="ws-quota-drawer">
          <span class="ws-qtitle">QUOTA</span>
          <span class="ws-qchips" id="ws-qchips">额度读取中…</span>
        </button>
        <div class="ws-qacts">
          <span id="ws-qtime">--:--</span>
          <button type="button" class="ws-qbtn" id="ws-qbtn-detail">详情 <span class="ws-qchev">▾</span></button>
          <button type="button" class="ws-qbtn" id="ws-qbtn-refresh" title="刷新额度"><span>↻</span></button>
        </div>
      </div>
      <div class="ws-quota-drawer" id="ws-quota-drawer" aria-hidden="true">
        <div class="ws-quota-inner">
          <div class="ws-qgrid" id="ws-qgrid"></div>
          <div class="ws-qusage" id="ws-qusage" hidden></div>
        </div>
      </div>
    </section>

    <section class="ws-vpn" id="ws-vpn" aria-label="VPN 用量与链路汇报">
      <div class="ws-vpn-bar">
        <div class="ws-vpn-head-left">
          <span class="ws-qtitle">VPN</span>
          <span class="ws-vpn-heading">流量与链路汇报</span>
          <span class="ws-vpn-pill" id="ws-vpn-pill"><span class="ws-qdot"></span>链路读取中…</span>
        </div>
        <div class="ws-qacts">
          <span id="ws-vpn-time">--:--</span>
          <button type="button" class="ws-qbtn" id="ws-vpn-copy" title="复制规范汇报文本">复制汇报</button>
          <button type="button" class="ws-qbtn" id="ws-vpn-toggle" aria-expanded="false" aria-controls="ws-vpn-drawer">汇报单 <span class="ws-qchev">▾</span></button>
          <button type="button" class="ws-qbtn" id="ws-vpn-refresh" title="强制刷新 VPN 与额度"><span>↻</span></button>
        </div>
      </div>

      <div class="ws-vpn-meter">
        <div class="ws-vpn-meter-row">
          <span class="ws-vpn-provider" id="ws-vpn-provider">订阅总池 · Clash</span>
          <span class="ws-vpn-summary" id="ws-vpn-summary">同步中…</span>
        </div>
        <div class="ws-vpn-track" aria-hidden="true">
          <i class="ws-vpn-up" id="ws-vpn-bar-up" style="width:0%"></i>
          <i class="ws-vpn-down" id="ws-vpn-bar-down" style="width:0%"></i>
        </div>
      </div>

      <div class="ws-vpn-grid" id="ws-vpn-grid">
        <div class="ws-vpn-cell">
          <div class="ws-vpn-k">订阅上行 / 下行</div>
          <div class="ws-vpn-v" id="ws-vpn-io">-- / --</div>
          <div class="ws-vpn-subv" id="ws-vpn-io-sub">--</div>
        </div>
        <div class="ws-vpn-cell">
          <div class="ws-vpn-k">剩余可用 / 到期</div>
          <div class="ws-vpn-v" id="ws-vpn-left">--</div>
          <div class="ws-vpn-subv" id="ws-vpn-exp">--</div>
        </div>
        <div class="ws-vpn-cell">
          <div class="ws-vpn-k">X230 出口节点</div>
          <div class="ws-vpn-v" id="ws-vpn-node">--</div>
          <div class="ws-vpn-subv" id="ws-vpn-node-sub">--</div>
        </div>
        <div class="ws-vpn-cell">
          <div class="ws-vpn-k">实时隧道速率</div>
          <div class="ws-vpn-v" id="ws-vpn-sess">-- / --</div>
          <div class="ws-vpn-subv" id="ws-vpn-sess-sub">--</div>
        </div>
      </div>

      <div class="ws-vpn-drawer" id="ws-vpn-drawer" aria-hidden="true">
        <div class="ws-vpn-drawer-inner">
          <div class="ws-vpn-report-wrap">
            <div class="ws-vpn-days" id="ws-vpn-days"></div>
            <div class="ws-vpn-report-box">
              <div class="ws-vpn-report-cap">
                <span>标准化汇报文本（可直接复制发送）</span>
                <button type="button" class="ws-qbtn" id="ws-vpn-copy-2">一键复制</button>
              </div>
              <pre class="ws-vpn-report" id="ws-vpn-report">正在生成汇报…</pre>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="ws-cf" id="ws-cf" aria-label="Codeforces 状态">
      <div class="ws-cf-bar">
        <button type="button" class="ws-cf-toggle" id="ws-cf-toggle" aria-expanded="false" aria-controls="ws-cf-drawer">
          <span class="ws-qtitle">CODEFORCES</span>
          <span class="ws-cf-summary" id="ws-cf-summary">zhang_tian_si_or_a_li · 读取中…</span>
        </button>
        <div class="ws-qacts">
          <a class="ws-qbtn" href="https://codeforces.com/profile/zhang_tian_si_or_a_li" target="_blank" rel="noopener">主页 ↗</a>
          <button type="button" class="ws-qbtn" id="ws-cf-btn-detail">详情 <span class="ws-qchev">▾</span></button>
          <button type="button" class="ws-qbtn" id="ws-cf-refresh" title="刷新 Codeforces 状态"><span>↻</span></button>
        </div>
      </div>
      <div class="ws-cf-drawer" id="ws-cf-drawer" aria-hidden="true">
        <div class="ws-cf-drawer-inner">
          <div class="ws-cf-grid" id="ws-cf-grid"></div>
        </div>
      </div>
    </section>

    <div class="ws-hud">
      <div class="ws-chips" role="tablist" aria-label="切换航点">
        <?= $chips ?>
      </div>
      <div class="ws-legend">
        <span class="leg-pub"><i></i>PUBLIC 直连</span>
        <span class="leg-gate"><i></i>GATE 鉴权</span>
        <span class="leg-lan"><i></i>LAN 局域网 / TAILSCALE</span>
      </div>
    </div>

    <section class="ws-deck" id="ws-deck" data-mode="one">
      <div class="panel-stack">
        <?= $panels ?>
      </div>
    </section>

    <footer class="ws-foot">
      <nav class="foot-links">
        <a href="/workspace/?out=1">LOCK<span>/ 锁上</span></a>
        <a href="/">HOME<span>/ 回到入口</span></a>
        <a href="https://stillfloating.top/?sf_blog=1">BLOG<span>/ 返回博客</span></a>
      </nav>
      <p class="foot-hint">悬停或点击星轨节点切换舱室 · ← → 换舱 · / 或 ⌘K 检索入口与天象 · Esc 看全部</p>
    </footer>
  </div>
</main>

<div class="ws-pal" id="ws-pal" role="dialog" aria-modal="true" aria-label="快速检索工作区" aria-hidden="true">
  <div class="ws-pal-box">
    <div class="ws-pal-head">
      <span class="ws-pal-prefix">SEARCH</span>
      <input type="search" id="ws-pal-input" aria-label="搜索工作区入口或天象" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="ws-pal-list" placeholder="输入服务名、域名、标签（如 terminal、lan、public、sky）…" autocomplete="off">
      <button type="button" class="ws-pal-esc" id="ws-pal-esc">ESC</button>
    </div>
    <ul class="ws-pal-list" id="ws-pal-list" role="listbox" aria-label="搜索结果"></ul>
  </div>
</div>

<script src="/workspace/ws.js?v=17"></script>
</body>
</html>

