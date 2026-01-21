const axios = require('axios');
const cheerio = require('cheerio');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const WP_API_URL = 'https://slowmoto.tours/wp-json/wp/v2';
const STRAPI_API_URL = 'http://localhost:1337/api';
// Ideally, use a token. If not provided, we rely on Public permissions.
const STRAPI_TOKEN = process.env.STRAPI_TOKEN || '';

const axiosConfig = {
  headers: STRAPI_TOKEN ? { Authorization: `Bearer ${STRAPI_TOKEN}` } : {},
};

// Map to store WP ID -> Strapi ID mappings
const categoryMap = new Map();
const imageMap = new Map(); // URL -> Strapi ID

async function fetchAll(endpoint) {
  let page = 1;
  let allResults = [];
  while (true) {
    console.log(`Fetching ${endpoint} page ${page}...`);
    try {
      const res = await axios.get(`${WP_API_URL}/${endpoint}?page=${page}&per_page=100`);
      allResults = allResults.concat(res.data);
      if (page >= res.headers['x-wp-totalpages']) break;
      page++;
    } catch (e) {
      if (e.response && e.response.status === 400) break; // End of pagination
      console.error(`Error fetching ${endpoint}:`, e.message);
      break;
    }
  }
  return allResults;
}

// Optimized upload to return URL
async function uploadImageAndGetUrl(imageUrl) {
    if (!imageUrl) return null;
    if (imageMap.has(imageUrl)) return { id: imageMap.get(imageUrl).id, url: imageMap.get(imageUrl).url }; // Optimization

    console.log(`Uploading image: ${imageUrl}`);
    try {
      const imageStream = await axios.get(imageUrl, { responseType: 'stream' });
      const formData = new FormData();
      const filename = path.basename(imageUrl).split('?')[0];

      formData.append('files', imageStream.data, filename);

      const uploadRes = await axios.post(`${STRAPI_API_URL}/upload`, formData, {
        headers: {
          ...axiosConfig.headers,
          ...formData.getHeaders(),
        },
      });

      if (uploadRes.data && uploadRes.data[0]) {
        const result = { id: uploadRes.data[0].id, url: uploadRes.data[0].url };
        imageMap.set(imageUrl, result);
        return result;
      }
    } catch (e) {
      console.error(`Failed to upload image ${imageUrl}:`, e.message);
    }
    return null;
}

async function migrateCategories() {
  console.log('Migrating Categories...');
  const categories = await fetchAll('categories');
  for (const cat of categories) {
    try {
      const res = await axios.post(`${STRAPI_API_URL}/categories`, {
        data: {
          name: cat.name,
          slug: cat.slug,
          description: cat.description,
          wp_id: cat.id
        }
      }, axiosConfig);
      categoryMap.set(cat.id, res.data.data.id);
      console.log(`Created Category: ${cat.name}`);
    } catch (e) {
      console.error(`Failed to create category ${cat.name}:`, e.message);
    }
  }
}

async function migratePosts() {
  console.log('Migrating Posts (Articles)...');
  const posts = await fetchAll('posts');
  for (const post of posts) {
    const featuredMediaUrl = post._links['wp:featuredmedia'] ?
      (await axios.get(post._links['wp:featuredmedia'][0].href).catch(() => ({data:{source_url:null}}))).data.source_url
      : null;

    let coverId = null;
    if (featuredMediaUrl) {
        const upload = await uploadImageAndGetUrl(featuredMediaUrl);
        if (upload) coverId = upload.id;
    }

    // Process Content
    let content = post.content.rendered;
    const $ = cheerio.load(content);
    const images = $('img');
    for (let i=0; i<images.length; i++) {
        const img = $(images[i]);
        const src = img.attr('src');
        if (src) {
            const upload = await uploadImageAndGetUrl(src);
            if (upload) {
                img.attr('src', upload.url);
            }
        }
    }
    // Remove Elementor comments and attributes
    $.root().contents().filter((i, el) => el.type === 'comment').remove();
    $('*').each((i, el) => {
        const attribs = el.attribs;
        for (const attr in attribs) {
          if (attr.startsWith('data-elementor')) {
            $(el).removeAttr(attr);
          }
        }
    });
    content = $('body').html();

    // Map Categories
    const catIds = post.categories.map(id => categoryMap.get(id)).filter(id => id);

    try {
      await axios.post(`${STRAPI_API_URL}/articles`, {
        data: {
          title: post.title.rendered,
          slug: post.slug,
          description: post.excerpt.rendered.replace(/<[^>]*>?/gm, '').slice(0, 80),
          cover: coverId,
          category: catIds.length > 0 ? catIds[0] : null,
          blocks: [
              {
                  __component: 'shared.rich-text',
                  body: content
              }
          ],
          wp_id: post.id
        }
      }, axiosConfig);
      console.log(`Created Article: ${post.title.rendered}`);
    } catch (e) {
      console.error(`Failed to create article ${post.title.rendered}:`, e.response?.data || e.message);
    }
  }
}

async function migratePages() {
  console.log('Migrating Pages...');
  const pages = await fetchAll('pages');

  for (const page of pages) {
    const isTour = /Tour Duration:/i.test(page.content.rendered) || /Total Distance:/i.test(page.content.rendered);

    const featuredMediaUrl = page._links['wp:featuredmedia'] ?
      (await axios.get(page._links['wp:featuredmedia'][0].href).catch(() => ({data:{source_url:null}}))).data.source_url
      : null;

    let coverId = null;
    if (featuredMediaUrl) {
        const upload = await uploadImageAndGetUrl(featuredMediaUrl);
        if (upload) coverId = upload.id;
    }

    let content = page.content.rendered;
    const $ = cheerio.load(content);
    const images = $('img');
    for (let i=0; i<images.length; i++) {
        const img = $(images[i]);
        const src = img.attr('src');
        if (src) {
            const upload = await uploadImageAndGetUrl(src);
            if (upload) {
                img.attr('src', upload.url);
            }
        }
    }
    $.root().contents().filter((i, el) => el.type === 'comment').remove();
    $('*').each((i, el) => {
        const attribs = el.attribs;
        for (const attr in attribs) {
          if (attr.startsWith('data-elementor')) {
            $(el).removeAttr(attr);
          }
        }
    });
    content = $('body').html();

    if (isTour) {
        const durationMatch = content.match(/Tour Duration:<[^>]*>([\s\S]*?)<\/span>/i);
        const distanceMatch = content.match(/Total Distance:\s*(\d+\s*km)/i);

        const duration = durationMatch ? durationMatch[1].replace(/<br>/g, ' ').trim() : '';
        const distance = distanceMatch ? distanceMatch[1] : '';

        try {
            await axios.post(`${STRAPI_API_URL}/tours`, {
                data: {
                    title: page.title.rendered,
                    slug: page.slug,
                    content: content,
                    excerpt: page.excerpt.rendered.replace(/<[^>]*>?/gm, ''),
                    featured_image: coverId,
                    duration: duration,
                    distance: distance,
                    wp_id: page.id
                }
            }, axiosConfig);
            console.log(`Created Tour: ${page.title.rendered}`);
        } catch (e) {
            console.error(`Failed to create tour ${page.title.rendered}:`, e.response?.data || e.message);
        }
    } else {
        try {
            await axios.post(`${STRAPI_API_URL}/pages`, {
                data: {
                    title: page.title.rendered,
                    slug: page.slug,
                    content: content,
                    excerpt: page.excerpt.rendered.replace(/<[^>]*>?/gm, ''),
                    featured_image: coverId,
                    wp_id: page.id
                }
            }, axiosConfig);
            console.log(`Created Page: ${page.title.rendered}`);
        } catch (e) {
            console.error(`Failed to create page ${page.title.rendered}:`, e.response?.data || e.message);
        }
    }
  }
}

async function main() {
  console.log('Starting Migration...');
  console.log('IMPORTANT: Ensure Strapi is running (npm run develop) and permissions for Public role are set to "create" for Category, Article, Tour, Page, Upload.');

  await migrateCategories();
  await migratePosts();
  await migratePages();

  console.log('Migration Complete.');
}

main();
