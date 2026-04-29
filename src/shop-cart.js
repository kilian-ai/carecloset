import { PolymerElement, html } from '@polymer/polymer/polymer-element.js';
import './shop-button.js';
import './shop-common-styles.js';
import './shop-form-styles.js';

class ShopCart extends PolymerElement {
  static get template() {
    return html`
    <style include="shop-common-styles shop-button shop-form-styles">

      .list {
        margin: 40px 0;
      }

      .checkout-box {
        font-weight: bold;
        text-align: right;
        margin-right: 10px;
      }

      .subtotal {
        margin: 0 64px 0 24px;
      }

      @media (max-width: 767px) {

        .subtotal {
          margin: 0 0 0 24px;
        }

      }

    </style>

    <div class="main-frame">
      <div class="subsection" visible$="[[!_hasItems]]">
        <p class="empty-cart">Your <iron-icon icon="shopping-cart"></iron-icon> is empty.</p>
      </div>
      <div class="subsection" visible$="[[_hasItems]]">
        <header>
          <h1>Your Cart</h1>
          <span>([[_getPluralizedQuantity(cart.length)]])</span>
        </header>
        <div class="list">
          <dom-repeat items="[[cart]]" as="entry">
            <template>
              <shop-cart-item entry="[[entry]]"></shop-cart-item>
            </template>
          </dom-repeat>
        </div>
        <div class="checkout-box">
          Total: <span class="subtotal">[[_formatTotal(total)]]</span>
          <template is="dom-if" if="[[_authed]]">
            <shop-button responsive>
              <a href="/checkout">Checkout</a>
            </shop-button>
          </template>
          <template is="dom-if" if="[[!_authed]]">
            <shop-button responsive>
              <a href="/login.html?next=%2F">Sign in to checkout</a>
            </shop-button>
          </template>
        </div>
      </div>
    </div>
    `;
  }
  static get is() { return 'shop-cart'; }

  static get properties() { return {

    total: Number,

    cart: Array,

    visible: {
      type: Boolean,
      observer: '_visibleChanged'
    },

    _hasItems: {
      type: Boolean,
      computed: '_computeHasItem(cart.length)'
    },

    _authed: {
      type: Boolean,
      value: () => /(?:^|; )shop_authed=1(?:;|$)/.test(document.cookie)
    }

  }}

  _formatTotal(total) {
    return isNaN(total) ? '' : '$' + total.toFixed(2);
  }

  _computeHasItem(cartLength) {
    return cartLength > 0;
  }

  _getPluralizedQuantity(quantity) {
    return quantity + ' ' + (quantity === 1 ? 'item' : 'items');
  }

  _visibleChanged(visible) {
    if (visible) {
      // Refresh auth state in case the user signed in/out in another tab.
      this._authed = /(?:^|; )shop_authed=1(?:;|$)/.test(document.cookie);
      // Notify the section's title
      this.dispatchEvent(new CustomEvent('change-section', {
        bubbles: true, composed: true, detail: { title: 'Your cart' }}));
    }
  }

}

customElements.define(ShopCart.is, ShopCart);
