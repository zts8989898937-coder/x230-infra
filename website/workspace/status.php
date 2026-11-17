<?php
declare(strict_types=1);
// 只回答一个问题：这台浏览器有没有工作区权限。portal 用它决定 WORKSPACE 星体的文案。
require __DIR__ . '/lib.php';
sf_ws_headers();
header('Content-Type: application/json; charset=utf-8');
echo json_encode(['authorized' => sf_ws_authorized()], JSON_UNESCAPED_UNICODE);
