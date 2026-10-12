/* Every Amazon DOM hook Fakeazon depends on, in one place.
 * Amazon changes markup often: when something stops being scraped, fix it here.
 * Lists are tried in order; the first match with usable content wins.
 * (Checkout safety does not depend on these: rules.json blocks the checkout and
 * sign-in URLs at the network level regardless.) */
globalThis.FKZ_SEL = {
  // URLs that mean "this goes to a real checkout / sign-in".
  checkoutUrl: /\/gp\/buy\/|\/checkout\/|\/gp\/checkoutportal|go-to-checkout|proceedToRetailCheckout|proceedToCheckout/i,
  signinUrl: /\/ap\/signin|\/ap\/register|\/ax\/claim/i,

  // Anything that can trigger navigation/submit when clicked.
  clickable: 'a, button, input[type="submit"], input[type="image"], input[type="button"], [role="button"], .a-button',

  buyNow: ['#buy-now-button', 'input[name="submit.buy-now"]', '#buyNow'].join(', '),

  checkout: [
    'input[name="proceedToRetailCheckout"]',
    '#sc-buy-box-ptc-button',
    '[data-feature-id="proceed-to-checkout-action"]',
    '#attach-sidesheet-checkout-button',
    '#sw-ptc-form input[type="submit"]',
    '#hlb-ptc-btn-native',
    '#hlb-ptc-btn',
    '#nav-flyout-ewc a[href*="checkout"]',
    'a[href*="proceedToRetailCheckout"]',
  ].join(', '),

  // Submit-control names that mean checkout / buy now.
  checkoutName: /proceedToRetailCheckout|proceedToCheckout|submit\.buy-now|placeYourOrder/i,

  product: {
    title: ['#productTitle', '#title', '#ebooksProductTitle'],
    asinInput: ['#ASIN', 'input[name="ASIN"]', 'input[name="asin"]'],
    // Current price containers; .a-text-price is the struck-through list price, so skip it.
    price: [
      '#corePriceDisplay_desktop_feature_div .a-price:not(.a-text-price)',
      '#corePrice_feature_div .a-price:not(.a-text-price)',
      '#corePrice_desktop .a-price:not(.a-text-price)',
      '#apex_desktop .a-price:not(.a-text-price)',
      '#apex_offerDisplay_desktop .a-price:not(.a-text-price)',
      '#tp_price_block_total_price_ww',
      '#priceblock_dealprice',
      '#priceblock_ourprice',
      '#price_inside_buybox',
      '#newBuyBoxPrice',
      '#kindle-price',
      '.a-price:not(.a-text-price)',
    ],
    listPrice: [
      '#corePriceDisplay_desktop_feature_div .basisPrice .a-offscreen',
      '#corePriceDisplay_desktop_feature_div .a-text-price .a-offscreen',
      '#corePrice_desktop .a-text-price .a-offscreen',
      '#corePrice_feature_div .a-text-price .a-offscreen',
      '.basisPrice .a-offscreen',
      '#listPrice',
      '#priceblock_listprice',
    ],
    deal: ['#dealBadge_feature_div', '#dealBadgeSupportingText', '.dealBadge', '#deal_badge'],
    image: ['#landingImage', '#imgBlkFront', '#ebooksImgBlkFront', '#main-image', '#imgTagWrapperId img'],
    breadcrumbs: '#wayfinding-breadcrumbs_feature_div ul li a, #wayfinding-breadcrumbs_container ul li a',
    subnavCategory: '#nav-subnav[data-category]',
    searchAlias: '#searchDropdownBox option[selected]',
    qty: ['#quantity', 'select[name="quantity"]'],
  },

  cart: {
    activeRoot: ['#sc-active-cart', '#activeCartViewForm', 'form#activeCartViewForm', '[data-name="Active Items"]'],
    item: '.sc-list-item[data-asin]',
    title: ['.sc-product-title .a-truncate-full', '.sc-product-title', '.sc-grid-item-product-title', 'a.sc-product-link'],
    image: ['img.sc-product-image', '.sc-product-image', 'img'],
    link: ['a.sc-product-link', 'a[href*="/dp/"]', 'a[href*="/gp/product/"]'],
    price: ['.sc-product-price', '.sc-price', '.a-price .a-offscreen'],
    checkbox: 'input[type="checkbox"]',
    deleteBtn: [
      'input[value="Delete"]',
      'input[name^="submit.delete"]',
      '[data-action="delete"] input',
      '.sc-action-delete input',
      '[data-feature-id="delete"] input',
      'span[data-action="delete"] input',
    ],
  },
};
