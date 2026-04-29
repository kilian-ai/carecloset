import { PolymerElement, html } from '@polymer/polymer/polymer-element.js';
import '@polymer/app-route/app-route.js';
import '@polymer/iron-flex-layout/iron-flex-layout.js';
import './shop-button.js';
import './shop-common-styles.js';
import './shop-form-styles.js';
import './shop-input.js';

class ShopCheckout extends PolymerElement {
  static get template() {
    return html`
<style include="shop-common-styles shop-button shop-form-styles shop-input">

      .main-frame {
        transition: opacity 0.5s;
      }

      :host([waiting]) .main-frame {
        opacity: 0.1;
      }

      shop-input, shop-select {
        font-size: 16px;
      }

      shop-select {
        margin-bottom: 20px;
      }

      paper-spinner-lite {
        position: fixed;
        top: calc(50% - 14px);
        left: calc(50% - 14px);
      }

      .billing-address-picker {
        margin: 28px 0;
        height: 20px;
        @apply --layout-horizontal;
      }

      .billing-address-picker > label {
        margin-left: 12px;
      }

      .grid {
        margin-top: 40px;
        @apply --layout-horizontal;
      }

      .grid > section {
        @apply --layout-flex;
      }

      .grid > section:not(:first-child) {
        margin-left: 80px;
      }

      .row {
        @apply --layout-horizontal;
        @apply --layout-end;
      }

      .column {
        @apply --layout-vertical;
      }

      .row > .flex,
      .input-row > * {
        @apply --layout-flex;
      }

      .input-row > *:not(:first-child) {
        margin-left: 8px;
      }

      .shop-select-label {
        line-height: 20px;
      }

      .order-summary-row {
        line-height: 24px;
      }

      .total-row {
        font-weight: 500;
        margin: 30px 0;
      }

      @media (max-width: 767px) {

        .grid {
          display: block;
          margin-top: 0;
        }

        .grid > section:not(:first-child) {
          margin-left: 0;
        }

      }

    </style>

    <div class="main-frame">
      <iron-pages id="pages" selected="[[state]]" attr-for-selected="state">
        <div state="init">
          <div class="subsection" visible$="[[!_hasItems]]">
            <p class="empty-cart">Your <iron-icon icon="shopping-cart"></iron-icon> is empty.</p>
          </div>

          <header class="subsection" visible$="[[_hasItems]]">
            <h1>Checkout</h1>
          </header>

          <div class="subsection grid" visible$="[[_hasItems]]">
            <section>
              <h2 id="buyerHeading">Buyer (optional)</h2>
              <div class="row input-row">
                <shop-input>
                  <input type="text" id="buyerName" name="buyerName"
                      placeholder="Name (optional)" autofocus
                      aria-labelledby="buyerNameLabel buyerHeading">
                  <shop-md-decorator aria-hidden="true">
                    <label id="buyerNameLabel">Name (optional)</label>
                    <shop-underline></shop-underline>
                  </shop-md-decorator>
                </shop-input>
              </div>

              <h2>Order Summary</h2>
              <dom-repeat items="[[cart]]" as="entry">
                <template>
                  <div class="row order-summary-row">
                    <div class="flex">[[entry.item.title]]</div>
                    <div>[[_getEntryTotal(entry)]]</div>
                  </div>
                </template>
              </dom-repeat>
              <div class="row total-row">
                <div class="flex">Total</div>
                <div>[[_formatPrice(total)]]</div>
              </div>
              <shop-button responsive id="submitBox">
                <input type="button" on-click="_submit" value="Place Order">
              </shop-button>
            </section>
          </div>
        </div>


        <!-- Success message UI -->
        <header state="success">
          <h1>Thank you</h1>
          <p>[[response.successMessage]]</p>
          <shop-button responsive>
            <a href="/">Finish</a>
          </shop-button>
        </header>

        <!-- Error message UI -->
        <header state="error">
          <h1>We couldn&acute;t process your order</h1>
          <p id="errorMessage">[[response.errorMessage]]</p>
          <shop-button responsive>
            <a href="/checkout">Try again</a>
          </shop-button>
        </header>

      </iron-pages>

    </div>

    <!-- Handles the routing for the success and error subroutes -->
    <app-route
        active="{{routeActive}}"
        data="{{routeData}}"
        route="[[route]]"
        pattern="/:state">
     </app-route>

    <!-- Show spinner when waiting for the server to repond -->
    <paper-spinner-lite active="[[waiting]]"></paper-spinner-lite>
    `;
  }
  static get is() { return 'shop-checkout'; }

  static get properties() { return {

    /**
     * The route for the state. e.g. `success` and `error` are mounted in the
     * `checkout/` route.
     */
    route: {
      type: Object,
      notify: true
    },

    /**
     * The total price of the contents in the user's cart.
     */
    total: Number,

    /**
     * The state of the form. Valid values are:
     * `init`, `success` and `error`.
     */
    state: {
      type: String,
      value: 'init'
    },

    /**
     * An array containing the items in the cart.
     */
    cart: Array,

    /**
     * The server's response.
     */
    response: Object,

    /**
     * If true, shop-checkout is currently visible on the screen.
     */
    visible: {
      type: Boolean,
      observer: '_visibleChanged'
    },

    /**
     * True when waiting for the server to repond.
     */
    waiting: {
      type: Boolean,
      readOnly: true,
      reflectToAttribute: true
    },

    /**
     * True when waiting for the server to repond.
     */
    _hasItems: {
      type: Boolean,
      computed: '_computeHasItem(cart.length)'
    }

  }}

  static get observers() { return [
    '_updateState(routeActive, routeData)'
  ]}

  _submit(e) {
    if (!this.cart || !this.cart.length) return;
    const buyerName = (this.$.buyerName.value || '').trim();
    const soldAt = new Date().toISOString();

    this._setWaiting(true);

    const updates = this.cart.map(entry => {
      const item = entry.item || {};
      const cat = encodeURIComponent(item.category);
      const name = encodeURIComponent(item.name);
      const body = { sold: true, soldAt };
      if (buyerName) body.soldTo = buyerName;
      return fetch(`/api/items/${cat}/${name}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)));
    });

    Promise.all(updates).then(() => {
      this.response = {
        success: 1,
        successMessage: buyerName
          ? `Order recorded for ${buyerName}.`
          : 'Order recorded.'
      };
      this._setWaiting(false);
      this._pushState('success');
      this.dispatchEvent(new CustomEvent('clear-cart', { bubbles: true, composed: true }));
    }).catch(err => {
      this.response = {
        success: 0,
        errorMessage: (err && err.message) || 'Could not record order.'
      };
      this._setWaiting(false);
      this._pushState('error');
    });
  }

  /**
   * Sets the valid state and updates the location.
   */
  _pushState(state) {
    this._validState = state;
    this.set('route.path', state);
  }

  /**
   * Checks that the `:state` subroute is correct. That is, the state has been pushed
   * after receiving response from the server. e.g. Users can only go to `/checkout/success`
   * if the server responsed with a success message.
   */
  _updateState(active, routeData) {
    if (active && routeData) {
      let state = routeData.state;
      if (this._validState === state) {
        this.state = state;
        this._validState = '';
        return;
      }
    }
    this.state = 'init';
  }

  /**
   * Sets the initial state.
   */
  _reset() {
    this._setWaiting(false);
    if (this.$.buyerName) this.$.buyerName.value = '';
  }

  /**
   * Handles the response from the server by checking the response status
   * and transitioning to the success or error UI.
   */
  _didReceiveResponse(e) {
    // Legacy iron-form path; no longer used. Kept as a no-op for safety.
  }

  _computeHasItem(cartLength) {
    return cartLength > 0;
  }

  _formatPrice(total) {
    return isNaN(total) ? '' : '$' + total.toFixed(2);
  }

  _getEntryTotal(entry) {
    return this._formatPrice(entry.quantity * entry.item.price);
  }

  _visibleChanged(visible) {
    if (!visible) {
      return;
    }
    // Reset the UI states
    this._reset();
    // Notify the page's title
    this.dispatchEvent(new CustomEvent('change-section', {
      bubbles: true, composed: true, detail: { title: 'Checkout' }}));
  }

}

customElements.define(ShopCheckout.is, ShopCheckout);
