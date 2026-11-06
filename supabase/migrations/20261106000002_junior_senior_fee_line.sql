-- Junior Playing Senior Cricket Fee as a non-stock line (see
-- 20261106000001). Record-keeping only. Applied after the deploy of the
-- code that reads stock_items.non_stock.
--
-- Product and its single default variant confirmed from
-- wix-import ?raw=1&product=cricket fee on 6 Nov 2026 ($40, Wix
-- trackQuantity false).
insert into stock_items (
  name, category, size, price, quantity, low_stock_alert, target_level,
  wix_product_id, wix_variant_id, wix_product_url, image_url, non_stock
) values (
  'Junior Playing Senior Cricket Fee', 'Other', 'One size', 40, 0, 0, 0,
  'b2d838e8-fabe-3a27-bc36-2ffaa6ccad21',
  'f7cf325b-2c18-4834-bb86-b7f6973918a7',
  'https://www.macedoncricket.com.au/product-page/junior-playing-senior-cricket-fee',
  'https://static.wixstatic.com/media/c72881_9df42ab8e6aa4092a5d460aedc80b082~mv2.png',
  true
);
