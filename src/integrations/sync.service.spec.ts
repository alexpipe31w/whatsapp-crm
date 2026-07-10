// src/integrations/sync.service.spec.ts — solo funciones puras
import { productToWire, wireToProductData } from './sync.service';

describe('mapeo wire', () => {
  const crmProduct = {
    productId: 'p1', stockupProductId: null, name: 'Inositol', description: '<p>desc</p>',
    sku: 'INSO', salePrice: 60000 as any, costPrice: 25000 as any, stock: 100,
    hasVariants: false, images: ['https://img'], imageUrl: 'https://img', isActive: true,
    category: { categoryId: 'c1', stockupCategoryId: 'sc1', name: 'Vitaminas' },
    variants: [],
  };

  it('CRM → wire', () => {
    const w = productToWire(crmProduct as any);
    expect(w).toMatchObject({
      sourceId: 'p1', targetId: null, name: 'Inositol', sku: 'INSO',
      price: 60000, costPrice: 25000, stock: 100, images: ['https://img'],
      isActive: true, hasVariants: false,
      category: { sourceId: 'c1', targetId: 'sc1', name: 'Vitaminas' },
    });
  });

  it('wire → data de escritura CRM', () => {
    const d = wireToProductData({
      sourceId: 's9', targetId: null, name: 'Nuevo', description: null, sku: null,
      price: 1000, costPrice: 0, stock: 3, images: [], isActive: true,
      hasVariants: false, category: null, variants: [],
    });
    expect(d).toMatchObject({
      name: 'Nuevo', salePrice: 1000, costPrice: 0, stock: 3,
      images: [], imageUrl: null, isActive: true, stockupProductId: 's9',
    });
  });
});
