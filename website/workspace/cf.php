<?php
declare(strict_types=1);

require __DIR__ . '/lib.php';

sf_ws_headers();

if (!sf_ws_authorized()) {
    http_response_code(403);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => 'forbidden'], JSON_UNESCAPED_UNICODE);
    exit;
}

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

$secretFile = '/www/wwwroot/156.239.8.225/wp-content/sf-private/writer-secret.php';
$cfg = is_file($secretFile) ? include $secretFile : [];
$cfg = is_array($cfg) ? $cfg : [];
$base = rtrim((string) ($cfg['daemon_url'] ?? 'http://127.0.0.1:18015'), '/');
$internalSecret = (string) ($cfg['internal_secret'] ?? '');
$forceQuery = (isset($_GET['force']) && $_GET['force'] === '1') ? '?force=1' : '';

if (!function_exists('curl_init')) {
    http_response_code(503);
    echo json_encode(['error' => 'curl_unavailable'], JSON_UNESCAPED_UNICODE);
    exit;
}

$ch = curl_init($base . '/cf/summary' . $forceQuery);
if ($ch === false) {
    http_response_code(500);
    echo json_encode(['error' => 'curl_init_failed'], JSON_UNESCAPED_UNICODE);
    exit;
}

curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_CONNECTTIMEOUT => 3,
    CURLOPT_TIMEOUT => 18,
    CURLOPT_HTTPHEADER => [
        'Accept: application/json',
        'X-SF-Internal: ' . $internalSecret,
    ],
]);

$body = curl_exec($ch);
$code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if (!is_string($body) || $body === '') {
    http_response_code($code ?: 502);
    echo json_encode(['error' => 'cf_daemon_unavailable'], JSON_UNESCAPED_UNICODE);
    exit;
}

http_response_code($code ?: 200);
echo $body;
