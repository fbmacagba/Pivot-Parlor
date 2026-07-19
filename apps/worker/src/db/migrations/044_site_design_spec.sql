-- Site Design v3 (Design Director): the composition spec chosen for the site.
-- JSON DesignSpec (see @repo/utils designSpec.ts). NULL for v1/v2 sites.
ALTER TABLE shop_sites ADD COLUMN design_spec TEXT;
