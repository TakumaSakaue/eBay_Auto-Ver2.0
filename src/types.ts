export type SearchRequestBody = {
  sellers: string[];
  maxPerSeller?: number;
};

export type SearchItem = {
  sellerId: string | null;
  itemId: string | null;
  title: string | null;
  priceValue: number | null;
  priceCurrency: string | null;
  watchCount: number | null;
  url: string | null;
  listedAt?: string | null;
};

export type SearchResponseBody = {
  items: SearchItem[];
  meta: {
    sellers: string[];
    maxPerSeller: number;
    total: number;
  };
};


