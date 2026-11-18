<?php
declare(strict_types=1);

// 私人工作区的共享逻辑：口令签发、cookie 校验、页面外壳。
// 密钥不放在站点根下，避免被当成静态文件读走。
const SF_WS_COOKIE = 'sf_ws';
const SF_WS_TTL = 5184000; // 60 天，够整个学期不用重进
// 站点开了 open_basedir，密钥必须留在站点根内；用 .php 存数组，
// 直接访问只会被 PHP 执行（无输出），不会像 .json 那样被当静态文件读走。
const SF_WS_SECRET = '/www/wwwroot/192.0.2.10/wp-content/sf-private/workspace-secret.php';

function sf_ws_secret(): array
{
    static $cache = null;
    if ($cache !== null) {
        return $cache;
    }
    $data = is_file(SF_WS_SECRET) ? include SF_WS_SECRET : null;
    $data = is_array($data) ? $data : [];
    if (!isset($data['key']) || !is_string($data['key']) || strlen($data['key']) < 32) {
        $data['key'] = '';
    }
    $cache = $data;
    return $cache;
}

function sf_ws_sign(string $expiry, string $key): string
{
    return hash_hmac('sha256', 'sf-ws|' . $expiry, $key);
}

function sf_ws_authorized(): bool
{
    $secret = sf_ws_secret();
    if (empty($secret['key']) || empty($_COOKIE[SF_WS_COOKIE])) {
        return false;
    }
    if (!preg_match('/^(\d{10})\.([0-9a-f]{64})$/', (string) $_COOKIE[SF_WS_COOKIE], $match)) {
        return false;
    }
    if ((int) $match[1] < time()) {
        return false;
    }
    return hash_equals(sf_ws_sign($match[1], (string) $secret['key']), $match[2]);
}

function sf_ws_grant(): string
{
    $secret = sf_ws_secret();
    $expiry = (string) (time() + SF_WS_TTL);
    return $expiry . '.' . sf_ws_sign($expiry, (string) ($secret['key'] ?? ''));
}

function sf_ws_attempts_path(): string
{
    return dirname(SF_WS_SECRET) . '/ws-attempts.json';
}

function sf_ws_attempts(): array
{
    $path = sf_ws_attempts_path();
    if (!is_file($path)) {
        return [];
    }
    $raw = @file_get_contents($path);
    $data = $raw === false ? null : json_decode($raw, true);
    return is_array($data) ? $data : [];
}

// 每 IP 10 分钟内最多 8 次失败，防止在线猜口令。
function sf_ws_with_lock(callable $fn)
{
    $path = sf_ws_attempts_path() . '.lock';
    $fp = @fopen($path, 'c');
    if ($fp === false) {
        return $fn();
    }
    @flock($fp, LOCK_EX);
    try {
        return $fn();
    } finally {
        @flock($fp, LOCK_UN);
        @fclose($fp);
    }
}

function sf_ws_rate_ok(int $limit = 8, int $window = 600): bool
{
    return sf_ws_with_lock(static function () use ($limit, $window): bool {
        $ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '?');
        $now = time();
        $all = sf_ws_attempts();
        $list = array_values(array_filter($all[$ip] ?? [], static fn ($t) => (int) $t > $now - $window));
        return count($list) < $limit;
    });
}

function sf_ws_note_failure(): void
{
    sf_ws_with_lock(static function (): void {
        $ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '?');
        $now = time();
        $all = sf_ws_attempts();
        $all[$ip] = array_values(array_filter($all[$ip] ?? [], static fn ($t) => (int) $t > $now - 86400));
        $all[$ip][] = $now;
        if (count($all) > 200) {
            $all = array_slice($all, -200, null, true);
        }
        @file_put_contents(sf_ws_attempts_path(), json_encode($all), LOCK_EX);
    });
}

function sf_ws_clear_failures(): void
{
    $ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '?');
    $all = sf_ws_attempts();
    unset($all[$ip]);
    @file_put_contents(sf_ws_attempts_path(), json_encode($all), LOCK_EX);
}

function sf_ws_headers(): void
{
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    header('Referrer-Policy: no-referrer');
    header('X-Robots-Tag: noindex, nofollow');
    header('X-Frame-Options: DENY');
    header('X-Content-Type-Options: nosniff');
}

function sf_ws_e(string $value): string
{
    return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function sf_ws_url(string $url): string
{
    $u = trim($url);
    if ($u === '' || preg_match('~^https?://~i', $u) || preg_match('~^/(?![/\\])~', $u)) {
        return $u;
    }
    return '#';
}

/** 一行入口。$row: label, sub, note, href, tag, ts(bool) */
function sf_ws_row_html(array $row, int $index): string
{
    $tag = (string) ($row['tag'] ?? '');
    $ts = !empty($row['ts']);
    $tagHtml = $tag === '' ? '<span></span>'
        : '<span class="tag' . ($ts ? ' tag-ts' : '') . '">' . ($ts ? '<i></i>' : '') . sf_ws_e($tag) . '</span>';
    $note = (string) ($row['note'] ?? '');
    return '<a class="row' . ($ts ? ' ts' : '') . '" href="' . sf_ws_e(sf_ws_url((string) $row['href'])) . '" target="_blank" rel="noopener">'
        . '<span class="num">' . str_pad((string) ($index + 1), 2, '0', STR_PAD_LEFT) . '</span>'
        . '<span class="main"><span class="label">' . sf_ws_e((string) $row['label']) . '</span>'
        . '<span class="sub">' . sf_ws_e((string) ($row['sub'] ?? '')) . '</span>'
        . ($note === '' ? '' : '<span class="note">' . sf_ws_e($note) . '</span>') . '</span>'
        . $tagHtml
        . '<span class="arr" aria-hidden="true">↗</span></a>';
}

/** @param array<int, array{cn:string, en:string, rows:array<int, array<string, mixed>>}> $groups */
function sf_ws_shell(string $title, string $kicker, string $body, array $rows = [], string $footer = '', array $groups = []): string
{
    $list = '';
    if ($groups !== []) {
        $counter = 0;
        foreach ($groups as $group) {
            $groupRows = is_array($group['rows'] ?? null) ? $group['rows'] : [];
            $items = '';
            foreach ($groupRows as $row) {
                $items .= sf_ws_row_html($row, $counter++);
            }
            if ($items === '') {
                continue;
            }
            $cn = (string) ($group['cn'] ?? '');
            $en = (string) ($group['en'] ?? '');
            $list .= '<section class="group">'
                . '<div class="group-head"><h2 class="group-zh">' . sf_ws_e($cn) . '</h2>'
                . '<span class="group-en">' . sf_ws_e($en) . ' · ' . str_pad((string) count($groupRows), 2, '0', STR_PAD_LEFT) . '</span></div>'
                . '<nav class="rows" aria-label="' . sf_ws_e($cn) . '">' . $items . '</nav>'
                . '</section>';
        }
    } else {
        // 兼容：denied 等页面仍以平铺 $rows 传参。
        $items = '';
        foreach ($rows as $i => $row) {
            $items .= sf_ws_row_html($row, (int) $i);
        }
        $list = $items === '' ? '' : '<nav class="rows" aria-label="工作区入口">' . $items . '</nav>';
    }
    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        . '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
        . '<meta name="robots" content="noindex,nofollow">'
        . '<meta name="theme-color" content="#0a0a0c">'
        . '<title>' . sf_ws_e($title) . '</title><style>'
        . sf_ws_css()
        . '</style></head><body><main class="shell">'
        . '<header class="head"><span class="mark" aria-hidden="true"></span>'
        . '<span class="kicker">' . sf_ws_e($kicker) . '</span></header>'
        . $body
        . $list
        . ($footer === '' ? '' : '<footer class="foot">' . $footer . '</footer>')
        . '</main></body></html>';
}

/** 只渲染外壳 + 自定义 body（工作区主页面用）。 */
function sf_ws_doc(string $title, string $kicker, string $body, string $footer = '', string $cls = ''): string
{
    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        . '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
        . '<meta name="robots" content="noindex,nofollow">'
        . '<meta name="theme-color" content="#0a0a0c">'
        . '<title>' . sf_ws_e($title) . '</title><style>'
        . sf_ws_css()
        . '</style></head><body class="' . sf_ws_e($cls) . '"><main class="shell">'
        . '<header class="head"><span class="mark" aria-hidden="true"></span>'
        . '<span class="kicker">' . sf_ws_e($kicker) . '</span></header>'
        . $body
        . ($footer === '' ? '' : '<footer class="foot">' . $footer . '</footer>')
        . '</main></body></html>';
}

function sf_ws_css(): string
{
    return <<<'CSS'
:root{--ink:#f1ece3;--muted:rgba(241,236,227,.58);--line:rgba(241,236,227,.14);--accent:#e9c17a;--ground:#0a0a0c;
--serif:"Noto Serif SC","Noto Serif TC","Songti SC","STSong","Source Han Serif SC",Georgia,serif;
--mono:ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;
--sans:-apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif}
*{box-sizing:border-box;margin:0;padding:0}
body{background-color:var(--ground);
background-image:radial-gradient(circle at 86% 10%,rgba(125,150,160,.09) 0%,transparent 48%),radial-gradient(rgba(242,243,242,.07) 1px,transparent 1px);
background-size:100% 100%,36px 36px;
color:var(--ink);font-family:var(--sans);-webkit-font-smoothing:antialiased;
min-height:100vh;padding:64px 24px 96px;display:flex;justify-content:center}
.shell{width:min(680px,100%)}
.head{display:flex;align-items:center;gap:10px;margin-bottom:34px;
font:500 10px/1.4 var(--mono);letter-spacing:.24em;text-transform:uppercase;color:var(--muted)}
.mark{width:8px;height:8px;border:1px solid var(--ink);border-radius:50%;box-shadow:inset 3px 0 0 var(--accent);flex:none}
.mast{padding-bottom:30px;margin-bottom:52px;border-bottom:1px solid var(--line);
display:flex;justify-content:space-between;align-items:flex-end;gap:16px}
.mast-title{font-family:var(--serif);font-size:clamp(28px,5vw,34px);font-weight:300;letter-spacing:-.03em;line-height:1.15}
.mast-title span{font-family:var(--mono);font-size:10px;color:var(--muted);letter-spacing:.22em;
text-transform:uppercase;margin-left:10px}
.mast-meta{font-family:var(--mono);font-size:10px;color:var(--muted);letter-spacing:.12em;text-align:right;line-height:1.7}
.mast-meta b{color:var(--accent);font-weight:400}
.group{margin-bottom:46px}
.group-head{display:flex;align-items:baseline;gap:14px;margin-bottom:14px}
.group-zh{flex:none}
.group-zh{font-family:var(--serif);font-size:28px;font-weight:300;letter-spacing:-.02em;line-height:1.2}
.group-en{font-family:var(--mono);font-size:9px;color:var(--muted);letter-spacing:.24em;text-transform:uppercase}
.rows{border-top:1px solid var(--line)}
.row{position:relative;display:grid;grid-template-columns:40px 1fr auto 20px;align-items:baseline;gap:12px;
padding:14px 0;border-bottom:1px solid var(--line);color:var(--ink);text-decoration:none;
transition:padding-left .24s cubic-bezier(.22,1,.36,1)}
.row::after{content:"";position:absolute;left:0;bottom:-1px;width:100%;height:1px;background:var(--accent);
transform:scaleX(0);transform-origin:left center;transition:transform .28s cubic-bezier(.22,1,.36,1)}
.row:hover{padding-left:10px}
.row:hover::after{transform:scaleX(1)}
.row:focus-visible{outline:1px solid var(--accent);outline-offset:4px}
.num{font-family:var(--mono);font-size:11px;color:var(--accent);letter-spacing:.06em}
.main{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 12px;min-width:0}
.label{font-size:15px;letter-spacing:.01em}
.sub{font-family:var(--mono);font-size:9px;color:var(--muted);letter-spacing:.12em;text-transform:uppercase}
.note{font-size:12px;color:var(--muted);width:100%;margin-top:-3px}
.row.ts .sub::after{content:"";display:none}
.tag{font-family:var(--mono);font-size:9px;color:var(--muted);letter-spacing:.14em;text-transform:uppercase;
padding:2px 6px;border:1px solid var(--line);line-height:1.3;white-space:nowrap}
.tag-ts{border-color:rgba(238,152,51,.36);color:var(--ink)}
.tag-ts i{display:inline-block;width:4px;height:4px;background:var(--accent);vertical-align:middle;margin-right:5px;margin-top:-1px}
.arr{font-family:var(--mono);font-size:12px;color:var(--muted);text-align:right;transition:transform .22s ease,color .22s ease}
.row:hover .arr{transform:translate(3px,-2px);color:var(--accent)}
.foot{margin-top:64px;padding-top:20px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:12px}
.foot-links{display:flex;flex-wrap:wrap;gap:24px;font-family:var(--mono);font-size:10px;letter-spacing:.1em}
.foot-links a{color:var(--ink);text-decoration:none;border-bottom:1px solid transparent;padding-bottom:2px;transition:border-color .2s,color .2s}
.foot-links a span{color:var(--muted);margin-left:4px}
.foot-links a:hover{color:var(--accent);border-bottom-color:var(--accent)}
.foot-hint{font-family:var(--mono);font-size:9px;color:var(--muted);letter-spacing:.06em;line-height:1.7}

/* ---- 动效：照 koimsurai 的 enter / draw / swap ---- */
@keyframes bay-rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
@keyframes bay-fade{from{opacity:0}to{opacity:1}}
@keyframes bay-dot{0%,100%{opacity:.35;transform:scale(.85)}50%{opacity:1;transform:scale(1)}}
@keyframes bay-drift{from{background-position:0 0}to{background-position:0 -420px}}
@keyframes bay-fadeout{to{opacity:0;transform:translateY(-6px)}}
@keyframes bay-twinkle{0%,100%{opacity:.12}50%{opacity:.5}}
@keyframes band-slide{from{transform:translateY(14px)}to{transform:translateY(-34px)}}
@keyframes ring-spin{to{transform:rotate(360deg)}}
@keyframes orbit-spin{from{transform:rotate(-16deg)}to{transform:rotate(344deg)}}
@keyframes planet-bob{from{transform:translateY(0)}to{transform:translateY(-9px)}}
.enter{opacity:0;animation:bay-rise var(--dur-700) var(--easing-out) var(--d,0s) both}
.enter-fade{opacity:0;animation:bay-fade var(--dur-700) var(--easing-standard) var(--d,0s) both}
/* ---- 工作台：参考 koimsurai.com 的星图地平线 + 遥测 HUD + 衬线/等宽对照 ---- */
body.bay-page{--dur-100:.1s;--dur-200:.2s;--dur-250:.25s;--dur-300:.3s;--dur-400:.4s;--dur-500:.5s;--dur-700:.7s;
--easing-out:cubic-bezier(.22,1,.36,1);--easing-standard:cubic-bezier(.4,0,.2,1);--easing-back:cubic-bezier(.34,1.56,.64,1);
--ground:#0a0a0c;--ground-rgb:10,10,12;--paper:#f1ece3;--paper-rgb:241,236,227;
--amber:#d26a4c;--amber-rgb:210,106,76;--gold:#cbb38f;--flare:#e2708f;
--ink:var(--paper);--ink-body:rgba(var(--paper-rgb),.9);--ink-muted:rgba(var(--paper-rgb),.68);--ink-subtle:rgba(var(--paper-rgb),.46);
--line:rgba(var(--paper-rgb),.13);--line-soft:rgba(var(--paper-rgb),.075);--line-strong:rgba(var(--paper-rgb),.48);
--accent:var(--amber);
background:radial-gradient(ellipse 80% 42% at 50% 0%,rgba(203,179,143,.04),transparent 70%),var(--ground);
color:var(--ink-body);font-family:var(--sans)}
.bay-page .shell{width:min(1180px,100%)}
.bay-page .head{color:var(--ink-subtle);margin-bottom:16px}
.bay-page .mark{border-color:var(--line-strong);box-shadow:inset 3px 0 0 var(--accent)}
.baynav{display:flex;flex-wrap:wrap;--d:.02s;gap:12px 22px;align-items:center;margin:0 0 28px;font:11px var(--mono);letter-spacing:.14em}
.baynav a{color:var(--ink-muted);text-decoration:none;padding-bottom:3px;border-bottom:1px solid transparent;white-space:nowrap;transition:color .2s,border-color .2s}
.baynav a:hover{color:var(--ink);border-bottom-color:var(--accent)}
.baynav .sep{flex:1 1 auto}
.bay-search-btn{display:inline-flex;align-items:center;gap:8px;padding:4px 10px;border:1px solid var(--line);border-radius:3px;background:rgba(var(--paper-rgb),.025);
color:var(--ink-muted);font:10px var(--mono);letter-spacing:.12em;white-space:nowrap;cursor:pointer;transition:border-color .2s,color .2s,background .2s}
.bay-search-btn:hover,.bay-search-btn[aria-expanded="true"]{border-color:rgba(var(--amber-rgb),.55);color:var(--ink);background:rgba(var(--amber-rgb),.08)}
.bay-search-btn kbd{font:9px var(--mono);color:var(--ink-subtle);border:1px solid var(--line);padding:1px 4px;border-radius:2px}
.bay-page .mast{padding:0 0 24px;margin:0 0 26px;border-bottom:1px solid var(--line);--d:.08s}
.bay-page .mast-title{font-family:var(--serif);font-weight:400;font-size:clamp(34px,5vw,46px);
letter-spacing:.01em;line-height:1.1;color:var(--ink)}
.bay-page .mast-title span{font-family:var(--mono);font-size:10px;color:var(--ink-subtle);letter-spacing:.26em;
margin-left:16px;text-transform:uppercase}
.bay-page .mast-meta{font:10px/1.85 var(--mono);color:var(--ink-subtle);letter-spacing:.13em;text-align:right}
.bay-page .mast-meta b{color:var(--accent);font-weight:400}
.bay-page .mast-met{display:block;font-size:13px;color:var(--ink);letter-spacing:.08em;margin:2px 0 3px;font-variant-numeric:tabular-nums}
.ws-filter{display:none;align-items:center;gap:12px;margin:0 0 18px;padding:10px 14px;border:1px solid var(--line);
background:rgba(var(--paper-rgb),.025);border-radius:3px}
.ws-filter.is-open{display:flex;animation:bay-fade var(--dur-200) var(--easing-out)}
.ws-filter-label{font:10px var(--mono);color:var(--amber);letter-spacing:.16em;text-transform:uppercase;flex:none}
.ws-filter input{flex:1 1 auto;min-width:0;border:0;background:none;color:var(--ink);font:13px var(--sans);outline:none}
.ws-filter input::placeholder{color:var(--ink-subtle);font-size:12px}
.ws-filter-count{font:10px var(--mono);color:var(--ink-subtle);letter-spacing:.12em;flex:none}
.ws-filter-clear{border:0;background:none;color:var(--ink-muted);font:10px var(--mono);letter-spacing:.12em;cursor:pointer;padding:2px 6px}
.ws-filter-clear:hover{color:var(--amber)}
body.is-hidden *,body.is-hidden *::before,body.is-hidden *::after{animation-play-state:paused!important}
.ws-quota{position:relative;margin:-10px 0 22px;border-top:1px solid var(--line-soft);border-bottom:1px solid var(--line-soft);background:linear-gradient(180deg,rgba(var(--paper-rgb),.018),transparent);--d:.05s}
.ws-quota::after{content:"";position:absolute;left:0;bottom:-1px;width:100%;height:1px;background:linear-gradient(90deg,var(--amber),rgba(var(--amber-rgb),.22) 65%,transparent);
transform:scaleX(0);transform-origin:left center;transition:transform var(--dur-400) var(--easing-out);pointer-events:none}
.ws-quota:hover::after,.ws-quota.is-open::after{transform:scaleX(1)}
.ws-quota-bar{display:flex;align-items:center;gap:10px 14px;padding:9px 2px;flex-wrap:wrap}
.ws-quota-toggle{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:8px 14px;flex-wrap:wrap;
background:none;border:0;padding:0;color:var(--ink-muted);font:10px/1.6 var(--mono);letter-spacing:.08em;text-align:left;cursor:pointer}
.ws-quota-toggle:hover .ws-qtitle{color:var(--amber)}
.ws-qtitle{color:var(--ink-subtle);letter-spacing:.2em;text-transform:uppercase;flex:none;transition:color var(--dur-200) var(--easing-standard)}
.ws-quota.is-open .ws-qtitle{color:var(--amber)}
.ws-qchips{display:inline-flex;align-items:center;gap:6px 14px;flex-wrap:wrap;color:var(--ink)}
.ws-qchip{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.ws-qdot{width:5px;height:5px;border-radius:50%;flex:none;background:var(--gold)}
.ws-qdot.ok{background:var(--gold);opacity:.9}.ws-qdot.warn{background:#e2a856}.ws-qdot.crit{background:var(--amber)}
.ws-qacts{display:inline-flex;align-items:center;gap:8px;flex:none;font:10px var(--mono);letter-spacing:.1em;color:var(--ink-subtle)}
.ws-qbtn{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--line);background:rgba(var(--paper-rgb),.02);color:var(--ink-muted);
font:9px var(--mono);letter-spacing:.14em;padding:3px 9px;border-radius:2px;cursor:pointer;transition:border-color var(--dur-200) var(--easing-standard),color var(--dur-200) var(--easing-standard),background var(--dur-200) var(--easing-standard)}
.ws-qbtn:hover,.ws-quota.is-open #ws-qbtn-detail{border-color:rgba(var(--amber-rgb),.55);color:var(--ink);background:rgba(var(--amber-rgb),.06)}
.ws-qchev{display:inline-block;transition:transform var(--dur-300) var(--easing-out)}
.ws-quota.is-open .ws-qchev,.hud-quota-btn[aria-expanded="true"] .ws-qchev{transform:rotate(180deg)}
#ws-qbtn-refresh.is-spin span{display:inline-block;animation:ring-spin .65s var(--easing-out)}
.ws-quota-drawer{display:grid;grid-template-rows:0fr;opacity:0;visibility:hidden;
transition:grid-template-rows var(--dur-400) var(--easing-out),opacity var(--dur-250) var(--easing-standard),visibility 0s linear var(--dur-400)}
.ws-quota.is-open .ws-quota-drawer{grid-template-rows:1fr;opacity:1;visibility:visible;transition:grid-template-rows var(--dur-400) var(--easing-out),opacity var(--dur-300) var(--easing-out),visibility 0s}
.ws-quota-inner{overflow:hidden;min-height:0}
.ws-quota-drawer .ws-qgrid{border-top:1px solid var(--line-soft);padding:16px 0 18px}
.ws-hud-drawer{display:grid;grid-template-rows:0fr;opacity:0;visibility:hidden;margin:0;
transition:grid-template-rows var(--dur-400) var(--easing-out),opacity var(--dur-250) var(--easing-standard),margin var(--dur-400) var(--easing-out),visibility 0s linear var(--dur-400)}
.ws-hud-drawer.is-open{grid-template-rows:1fr;opacity:1;visibility:visible;margin:2px 0 18px;
transition:grid-template-rows var(--dur-400) var(--easing-out),opacity var(--dur-300) var(--easing-out),margin var(--dur-400) var(--easing-out),visibility 0s}
.ws-hud-drawer .ws-qgrid{border-bottom:1px solid var(--line-soft);padding:14px 0 18px}
.hud-quota-btn{display:inline-flex;align-items:center;gap:6px;background:none;border:0;padding:0;color:var(--ink-subtle);
font:10px var(--mono);letter-spacing:.12em;cursor:pointer;transition:color var(--dur-200) var(--easing-standard)}
.hud-quota-btn:hover,.hud-quota-btn[aria-expanded="true"]{color:var(--amber)}
.hud-quota-btn b{color:var(--ink);font-weight:400;transition:color var(--dur-200) var(--easing-standard)}
.hud-quota-btn:hover b,.hud-quota-btn[aria-expanded="true"] b{color:var(--paper)}
.ws-qgrid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0}
.ws-qcard{padding:4px 18px 6px;border-left:1px solid var(--line-soft);display:flex;flex-direction:column;justify-content:flex-start;
opacity:0;transform:translateY(8px);transition:opacity var(--dur-300) var(--easing-out) calc(var(--qi,0) * 45ms + 60ms),transform var(--dur-400) var(--easing-out) calc(var(--qi,0) * 45ms + 60ms)}
.ws-qcard:first-child{padding-left:2px;border-left:0}
.ws-qcard:last-child{padding-right:2px}
.ws-quota.is-open .ws-qcard,.ws-hud-drawer.is-open .ws-qcard{opacity:1;transform:translateY(0)}
.ws-qcard-top{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid var(--line-soft)}
.ws-qcard-name{font:400 15px/1.2 var(--serif);color:var(--ink)}
.ws-qcard-plan{font:9px var(--mono);color:var(--ink-subtle);letter-spacing:.14em;text-transform:uppercase}
.ws-qrow{margin-top:8px}
.ws-qrow-line{display:flex;justify-content:space-between;gap:8px;font:10px var(--mono);color:var(--ink-muted);margin-bottom:5px}
.ws-qrow-val{color:var(--ink);font-variant-numeric:tabular-nums}
.ws-qbar{height:2px;background:rgba(var(--paper-rgb),.08);border-radius:1px;overflow:hidden}
.ws-qbar i{display:block;height:100%;background:rgba(var(--paper-rgb),.65);transform-origin:left center;transform:scaleX(0);
transition:transform var(--dur-500) var(--easing-out) calc(var(--qi,0) * 45ms + 140ms)}
.ws-quota.is-open .ws-qbar i,.ws-hud-drawer.is-open .ws-qbar i{transform:scaleX(1)}
.ws-qbar i.warn{background:#e2a856}.ws-qbar i.crit{background:var(--amber)}
.ws-qreset{margin-top:4px;font:9px var(--mono);color:var(--ink-subtle);letter-spacing:.04em}
.ws-qerr{font:10px var(--mono);color:var(--amber);padding:4px 0}
@media (max-width:920px){
  .ws-qgrid{grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 0}
  .ws-qcard:nth-child(3){padding-left:2px;border-left:0}
  .ws-qcard:nth-child(n+3){padding-top:14px;border-top:1px solid var(--line-soft)}
}
@media (max-width:560px){
  .ws-qgrid{grid-template-columns:1fr;gap:14px}
  .ws-qcard{padding:12px 0 2px;border-left:0;border-top:1px solid var(--line-soft)}
  .ws-qcard:first-child{padding-top:2px;border-top:0}
}
.chips{display:flex;gap:22px;margin:0 0 10px;flex-wrap:wrap;align-items:baseline}
.chip{display:inline-flex;align-items:baseline;gap:7px;padding:0;border:0;background:none;
color:var(--ink-muted);font:13px var(--sans);cursor:pointer;transition:color var(--dur-200) var(--easing-standard)}
.chip span{font:10px var(--mono);color:var(--ink-subtle);letter-spacing:.1em}
.chip:hover{color:var(--ink)}
.chip[aria-selected="true"]{color:var(--ink)}
.chip[aria-selected="true"]::before{content:"●";font-size:7px;color:var(--amber);margin-right:-2px;transform:translateY(-2px)}
.chip[aria-selected="true"] span{color:var(--amber)}
.chart{position:relative;color:var(--paper);margin:0 0 4px;-webkit-mask-image:linear-gradient(#000 82%,transparent);mask-image:linear-gradient(#000 82%,transparent)}
.chart svg{width:100%;height:auto;display:block;overflow:visible}
.chart .skyfar,.chart .planetwrap,.chart .limb{will-change:transform}
.chart circle{fill:currentColor}
.chart .horizon-fill{fill:url(#horizonGlow)}
.chart .skyfar circle{opacity:.42}
.chart .band{fill:none;stroke:currentColor;stroke-width:1;vector-effect:non-scaling-stroke;transform-box:view-box}
.chart .band.b0{stroke-opacity:.75}
.chart .band.b1,.chart .band.b2,.chart .band.b3{stroke-dasharray:1.2 8;stroke-linecap:round}
.chart .band{animation:band-slide 11s ease-in-out infinite alternate}
.chart .band.b0{animation-duration:9s}
.chart .band.b1{animation-duration:12s}
.chart .band.b2{animation-duration:15s}
.chart .band.b3{animation-duration:18s}
/* 彗尾：一段亮光沿着航线一直往前跑 */
.chart .comet{fill:none;stroke:var(--amber);stroke-width:2.1;stroke-linecap:round;filter:drop-shadow(0 0 6px rgba(210,106,76,.6))}
.chart .comet.c1{stroke-opacity:.9;stroke-dasharray:74 1000;animation:comet-run 8.5s linear infinite}
.chart .comet.c2{stroke-opacity:.42;stroke-width:1.7;stroke-dasharray:40 1000;animation:comet-run 8.5s linear infinite .09s}
.chart .comet.c3{stroke-opacity:.2;stroke-width:1.3;stroke-dasharray:18 1000;animation:comet-run 8.5s linear infinite .18s}
@keyframes comet-run{from{stroke-dashoffset:74}to{stroke-dashoffset:-926}}
.chart .zone.lit .orb.core{fill:var(--amber)}
.chart .zone.lit .halo{opacity:.55}
.chart .zone.lit .clink{stroke:var(--amber);stroke-opacity:.7}
.chart .tick{stroke:rgba(var(--paper-rgb),.46);stroke-width:1;vector-effect:non-scaling-stroke}
.chart .route{fill:none;stroke:rgba(var(--paper-rgb),.45);stroke-width:1.1;vector-effect:non-scaling-stroke}
.chart .ticks circle{fill:rgba(var(--paper-rgb),.28)}
.chart .drop{stroke:rgba(var(--paper-rgb),.1);stroke-width:1;stroke-dasharray:2 7;vector-effect:non-scaling-stroke}
.chart .hit{fill:transparent;stroke:none}
.chart .halo{fill:url(#halo);opacity:0;transition:opacity var(--dur-300) var(--easing-out)}
.chart .star{fill:var(--paper);transition:fill var(--dur-200) var(--easing-standard)}
.chart .ring{fill:none;stroke:rgba(var(--paper-rgb),.45);stroke-width:1;vector-effect:non-scaling-stroke;
transition:stroke var(--dur-200) var(--easing-standard)}
.chart .dot{fill:rgba(var(--paper-rgb),.45);transition:fill var(--dur-200) var(--easing-standard)}
.chart .lb-num{font:11px var(--mono);fill:rgba(var(--paper-rgb),.5);letter-spacing:.12em;transition:fill var(--dur-200) var(--easing-standard)}
.chart .lb-cn{font:19px var(--serif);fill:var(--paper);transition:fill var(--dur-200) var(--easing-standard)}
.chart .lb-en{font:9px var(--mono);fill:rgba(var(--paper-rgb),.42);letter-spacing:.2em;transition:fill var(--dur-200) var(--easing-standard)}
.chart .ringset{animation:ring-spin 72s linear infinite;transform-origin:720px 1300px;transform-box:view-box}
.chart .trail{fill:rgba(var(--paper-rgb),.85)}
.chart .orb{fill:currentColor;opacity:.62;animation:orb-breathe 4.4s ease-in-out infinite alternate}
.chart .orb.o1{opacity:.42}
.chart .orb.o2{opacity:.26}
.chart .core-haze{fill:url(#halo);opacity:.5}
.chart .core-pin{fill:#fff;opacity:.92}
.chart .dust{fill:currentColor;opacity:.3;animation:orb-breathe 6.2s ease-in-out infinite alternate}
.chart .orb.core{opacity:.95}
.chart .clink{fill:none;stroke:currentColor;stroke-opacity:.52;stroke-width:1.1;vector-effect:non-scaling-stroke;
  stroke-dasharray:5 4;animation:clink-flow 3.4s linear infinite}
@keyframes clink-flow{to{stroke-dashoffset:-22}}
.chart .zone:hover .clink,.chart .zone.is-on .clink{stroke:var(--amber);stroke-opacity:.78}
@keyframes orb-breathe{from{opacity:.35}to{opacity:.95}}
.chart .zone:hover .orb,.chart .zone.is-on .orb{fill:var(--amber);opacity:1}
.chart .planetwrap{animation:planet-bob 9s ease-in-out infinite alternate;transform-box:fill-box}
.chart .planetwrap .rings{animation:orbit-spin 74s linear infinite;transform-box:fill-box;transform-origin:center}
.chart .planetwrap .moon{fill:var(--paper)}
.chart .craft path{fill:none;stroke:rgba(var(--paper-rgb),.7);stroke-width:1}
.chart .now{font:10px var(--mono);fill:rgba(var(--paper-rgb),.5);letter-spacing:.1em}
.chart .zone{cursor:pointer;outline:none}
.chart .zone:hover .halo{opacity:.42}
.chart .zone:hover .ring{stroke:rgba(var(--amber-rgb),.8)}
.chart .zone:hover .star{fill:var(--amber)}
.chart .zone:hover .lb-cn{fill:var(--amber)}
.chart .zone.is-on .halo{opacity:.72}
.chart .zone.is-on .star{fill:var(--amber)}
.chart .zone.is-on .ring{stroke:var(--amber)}
.chart .zone.is-on .lb-num{fill:var(--amber)}
.chart .zone.is-on .lb-cn{fill:var(--amber)}
.chart .zone.is-on .lb-en{fill:rgba(210,106,76,.85)}
.chart .zone.is-on .dot{fill:var(--amber)}
.chart .zone:focus-visible .ring{stroke:var(--amber)}
.hud{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:12px 24px;
padding:10px 0 14px;border-top:1px solid var(--line-soft);font:10px var(--mono);letter-spacing:.12em;color:var(--ink-subtle)}
.hud-left,.hud-right{display:flex;align-items:baseline;gap:20px;flex-wrap:wrap}
.hud-stat{display:inline-flex;align-items:baseline;gap:7px}
.hud-stat b{color:var(--amber);font-weight:400;font-size:12px}
.hud-stat span{color:var(--ink-muted)}
.log{border-top:1px solid var(--line);padding-top:22px;margin-top:0;--d:.26s}
.panel-stack{display:grid}
.panel-sec{grid-area:1 / 1}
.panel-sec[hidden]{display:none}
.panel-sec{opacity:0;visibility:hidden;
transition:opacity var(--dur-250) var(--easing-standard),visibility 0s linear var(--dur-250)}
.panel-sec[data-on]{opacity:1;visibility:visible;transition-delay:0s}
.log[data-mode="all"] .panel-stack{display:block}
.log[data-mode="all"] .panel-sec{grid-area:auto;margin:0 0 40px;opacity:1;visibility:visible}
.log[data-mode="all"] .panel-sec:last-child{margin-bottom:0}
.baystars{position:fixed;inset:0;pointer-events:none;z-index:0}
.baystars i{position:absolute;width:2px;height:2px;border-radius:50%;background:var(--paper);opacity:.2;animation:bay-twinkle 5s ease-in-out infinite}
.bay-page .shell{position:relative;z-index:1}
.panel-sec .item{animation:bay-rise var(--dur-500) var(--easing-out) both;animation-delay:calc(var(--i,0) * 45ms + 40ms)}
.panel-sec .ph,.panel-sec .ph-note{animation:bay-fade var(--dur-300) var(--easing-standard) both}
@media (prefers-reduced-motion:reduce){
  .enter,.enter-fade,.panel-sec,.panel-sec .item,.panel-sec .ph,.panel-sec .ph-note{animation:none!important;opacity:1!important}
  body.bay-page{animation:none!important}
  .chart .zone.is-on .lb-num{animation:none}
  .chart .comet,.chart .band,.chart .ringset,.chart .planetwrap,.chart .planetwrap .rings,.chart .clink,.chart .orb,.chart .dust{animation:none!important}
}
.ph{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;padding-top:0;margin-bottom:6px}
.ph-num{font:11px var(--mono);color:var(--amber);letter-spacing:.14em}
.ph h3{font:400 24px/1.2 var(--serif);letter-spacing:.01em;color:var(--ink)}
.ph-en{font:9px var(--mono);color:var(--ink-subtle);letter-spacing:.24em;text-transform:uppercase}
.ph-count{margin-left:auto;font:9px var(--mono);color:var(--ink-subtle);letter-spacing:.14em}
.ph-note{font-size:13px;color:var(--ink-muted);margin:6px 0 18px;line-height:1.8;max-width:34ch}
.items{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:54px}
.item{position:relative;display:grid;grid-template-columns:1fr auto auto;align-items:center;gap:4px 12px;padding:13px 0 12px;border-top:1px solid var(--line-soft);
color:var(--ink-body);text-decoration:none;transition:padding-left var(--dur-250) var(--easing-out)}
.item::after{content:"";position:absolute;left:0;top:-1px;width:100%;height:1px;background:var(--amber);
transform:scaleX(0);transform-origin:left center;transition:transform var(--dur-300) var(--easing-out)}
.item:nth-child(1),.item:nth-child(2){border-top:1px solid var(--line)}
.item[hidden]{display:none}
.item:hover{padding-left:8px}
.item:hover::after{transform:scaleX(1)}
.item:hover .it-label{color:var(--amber)}
.item:hover .it-arr{opacity:1;transform:translate(2px,-2px);color:var(--amber)}
.it-label{font-family:var(--serif);font-size:17px;line-height:1.35;color:var(--ink);transition:color var(--dur-200) var(--easing-standard)}
.it-sub{font:9px var(--mono);color:var(--ink-subtle);letter-spacing:.16em;text-transform:uppercase;grid-column:1}
.it-note{font-size:12px;color:var(--ink-muted);grid-column:1;line-height:1.65;margin-top:2px}
.item .tag{grid-column:2;grid-row:1 / span 2;align-self:center;border:0;color:var(--ink-subtle);
font:9px var(--mono);letter-spacing:.16em;padding:0;white-space:nowrap}
.item .it-arr{grid-column:3;grid-row:1 / span 2;font:11px var(--mono);color:var(--ink-subtle);opacity:.4;transition:opacity .2s,transform .2s,color .2s}
.item .tag-ts{color:rgba(210,106,76,.85)}
.item .tag-gate{color:rgba(210,106,76,.55)}
.item .tag-ts i{background:var(--amber)}
.ws-empty{display:none;padding:34px 0;font:12px var(--mono);color:var(--ink-subtle);letter-spacing:.1em;text-align:center}
.ws-empty.is-on{display:block}
.bay-page .foot{margin-top:44px;padding-top:18px;border-top:1px solid var(--line)}
.bay-page .foot-links a{color:var(--ink-muted);font-size:10px}
.bay-page .foot-links a span{color:var(--ink-subtle)}
.bay-page .foot-links a:hover{color:var(--ink);border-bottom-color:var(--accent)}
.bay-page .foot-hint{font-size:9px;color:var(--ink-subtle);letter-spacing:.08em}
@media (max-width:980px){
  .chips{display:flex;margin-bottom:8px}
  .chart .zone{cursor:default}
  .chart .hit{pointer-events:none}
  .bay-page .mast-meta{text-align:left;margin-top:12px}
}
@media (max-width:820px){
  .items{grid-template-columns:1fr}
  .item:nth-child(2){border-top:1px solid var(--line-soft)}
}
@media (max-width:620px){
  .chart{overflow:visible;height:auto}
  .chart .lb-cn,.chart .lb-en{display:none}
  .chart .lb-num{font-size:26px}
  .chart .now{font-size:20px}
  .chart .ring{stroke-width:3}
  .chips{column-gap:17px;row-gap:9px;font-size:12.5px}
  .chip{font-size:12.5px}
  .chip span{font-size:9.5px}
  .bay-page .shell{width:100%}
  .chart svg{width:100%}
  .hud{flex-direction:column;gap:6px}
  .baynav{margin-bottom:22px;gap:14px}
  .it-label{font-size:16px}
}
h1{font-family:var(--serif);font-weight:300;font-size:clamp(30px,6vw,44px);letter-spacing:-.03em;line-height:1.2}
.denied{display:grid;gap:20px;margin-top:clamp(40px,9vw,80px)}
.stamp{display:inline-flex;align-items:center;gap:10px;padding:7px 11px;border:1px solid var(--line);
font:500 9px/1 var(--mono);letter-spacing:.2em;color:var(--accent);width:max-content}
.stamp::before{content:"";width:5px;height:5px;background:var(--accent);border-radius:50%}
.denied p{max-width:44ch;color:var(--muted);font-size:14px;line-height:1.9}
.back{display:inline-block;margin-top:4px;color:var(--ink);text-decoration:none;
font:500 10px/1.4 var(--mono);letter-spacing:.18em;border-bottom:1px solid var(--line);padding-bottom:4px}
.gate{display:flex;gap:10px;max-width:420px;margin-top:2px}
.gate input{flex:1 1 auto;min-width:0;padding:11px 13px;border:1px solid var(--line);background:rgba(255,255,255,.03);
color:var(--ink);font:500 12px/1.2 var(--mono);letter-spacing:.14em;outline:none}
.gate input:focus{border-color:rgba(238,152,51,.7)}
.gate button{flex:none;padding:11px 16px;border:1px solid var(--line);background:none;color:var(--ink);
font:500 9px/1.2 var(--mono);letter-spacing:.18em;cursor:pointer}
.gate button:hover{border-color:var(--accent);color:var(--accent)}
@media (max-width:620px){
  body{padding:40px 18px 64px}
  .mast{flex-direction:column;align-items:flex-start;gap:12px;margin-bottom:44px}
  .mast-meta{text-align:left}
  .group{margin-bottom:44px}
  .group-zh{font-size:24px}
  .row{grid-template-columns:26px 1fr 16px;gap:9px;padding:14px 0}
  .tag{display:none}
  .row.ts .sub::after{content:" · TS";color:var(--accent);display:inline}
  .note{margin-top:1px}
  .foot-links{gap:18px}
}
CSS;
}
