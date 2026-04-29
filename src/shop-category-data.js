import { PolymerElement } from '@polymer/polymer/polymer-element.js';
import { Debouncer } from '@polymer/polymer/lib/utils/debounce.js';
import { timeOut } from '@polymer/polymer/lib/utils/async.js';

// Shared in-memory cache of categories so multiple <shop-category-data> elements
// don't each refetch.
let _categoriesPromise = null;
function fetchCategoriesOnce() {
  if (_categoriesPromise) return _categoriesPromise;
  _categoriesPromise = fetch('/api/categories', { credentials: 'same-origin' })
    .then(r => r.ok ? r.json() : [])
    .catch(() => []);
  return _categoriesPromise;
}

class ShopCategoryData extends PolymerElement {

  static get is() { return 'shop-category-data'; }

  static get properties() { return {

    categoryName: String,

    itemName: String,

    categories: {
      type: Array,
      value: () => [],
      readOnly: true,
      notify: true
    },

    category: {
      type: Object,
      computed: '_computeCategory(categoryName, categories)',
      notify: true
    },

    item: {
      type: Object,
      computed: '_computeItem(category.items, itemName)',
      notify: true
    },

    failure: {
      type: Boolean,
      notify: true,
      readOnly: true
    }

  }}

  constructor() {
    super();
    fetchCategoriesOnce().then(list => {
      // Ensure each entry has the fields the UI expects
      const normalized = (Array.isArray(list) ? list : []).map(c => ({
        name: c.name,
        title: c.title,
        image: c.image || '',
        placeholder: c.placeholder || ''
      }));
      this._setCategories(normalized);
    });
  }

  _getCategoryObject(categoryName) {
    for (let i = 0, c; c = this.categories[i]; ++i) {
      if (c.name === categoryName) {
        return c;
      }
    }
  }

  _computeCategory(categoryName, categories) {
    if (!categoryName || !categories || !categories.length) return;
    let categoryObj = this._getCategoryObject(categoryName);
    this._fetchItems(categoryObj, 1);
    return categoryObj;
  }

  _computeItem(items, itemName) {
    if (!items || !itemName) {
      return;
    }
    for (let i = 0, item; item = items[i]; ++i) {
      if (item.name === itemName) {
        return item;
      }
    }
  }

  _fetchItems(category, attempts) {
    this._setFailure(false);
    if (!category || category.items) {
      return;
    }
    this._getResource({
      url: '/api/inventory/' + category.name,
      onLoad(e) {
        const items = JSON.parse(e.target.responseText).filter(i => !i.sold);
        this.set('category.items', items);
      },
      onError(e) {
        this._setFailure(true);
      }
    }, attempts);
  }

  _getResource(rq, attempts) {
    let xhr = new XMLHttpRequest();
    xhr.addEventListener('load', rq.onLoad.bind(this));
    xhr.addEventListener('error', (e) => {
      if (attempts > 1) {
        this._getResourceDebouncer = Debouncer.debounce(this._getResourceDebouncer,
          timeOut.after(200), this._getResource.bind(this, rq, attempts - 1));
      } else {
        rq.onError.call(this, e);
      }
    });

    xhr.open('GET', rq.url);
    xhr.send();
  }

  refresh() {
    if (this.categoryName) {
      this._fetchItems(this._getCategoryObject(this.categoryName), 3);
    }
  }

}

customElements.define(ShopCategoryData.is, ShopCategoryData);
