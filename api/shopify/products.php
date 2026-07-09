<?php
declare(strict_types=1);

require __DIR__ . '/_lib.php';

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
    header('Allow: GET');
    send_json(405, ['error' => 'Method Not Allowed']);
}

$collection = trim((string) ($_GET['collection'] ?? 'all'));
$limit = (int) ($_GET['limit'] ?? 24);

try {
    $products = fetch_products($collection === '' ? 'all' : $collection, $limit);
    send_json(200, ['products' => $products], 'public, max-age=300, stale-while-revalidate=900');
} catch (Throwable $error) {
    send_json(500, [
        'error' => 'Unable to fetch products from the live Shopify storefront.',
        'detail' => $error->getMessage(),
    ]);
}
