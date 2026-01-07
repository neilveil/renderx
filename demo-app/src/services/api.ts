const API_BASE_URL = 'https://dummy-json.mock.beeceptor.com';

export interface Post {
  userId: number;
  id: number;
  title: string;
  body: string;
  link: string;
  comment_count: number;
}

export interface Comment {
  postId: number;
  id: number;
  name: string;
  email: string;
  body: string;
}

export interface Country {
  name: string;
  code: string;
}

export interface Continent {
  code: string;
  name: string;
  areaSqKm: number;
  population: number;
  lines: string[];
  countries: number;
  oceans: string[];
  developedCountries: string[];
}

export const api = {
  async getPosts(): Promise<Post[]> {
    const response = await fetch(`${API_BASE_URL}/posts`);
    if (!response.ok) {
      throw new Error('Failed to fetch posts');
    }
    return response.json();
  },

  async getPost(id: number): Promise<Post> {
    const response = await fetch(`${API_BASE_URL}/posts/${id}`);
    if (!response.ok) {
      throw new Error('Failed to fetch post');
    }
    return response.json();
  },

  async getComments(): Promise<Comment[]> {
    const response = await fetch(`${API_BASE_URL}/comments`);
    if (!response.ok) {
      throw new Error('Failed to fetch comments');
    }
    return response.json();
  },

  async getCountries(): Promise<Country[]> {
    const response = await fetch(`${API_BASE_URL}/countries`);
    if (!response.ok) {
      throw new Error(`Failed to fetch countries: ${response.status} ${response.statusText}`);
    }
    const text = await response.text();
    try {
      // Try parsing as JSON first
      return JSON.parse(text);
    } catch (e) {
      // If JSON parsing fails, the API might be returning JavaScript object notation
      // The response format is: [{name: 'Country', code: 'XX'}, ...]
      // We need to convert it to valid JSON
      try {
        // Use Function constructor to safely parse JavaScript object notation
        // This is safer than eval and works for simple object literals
        const parsed = new Function('return ' + text)() as Country[];
        if (Array.isArray(parsed)) {
          return parsed;
        }
        throw new Error('Response is not an array');
      } catch (parseError) {
        console.error('Failed to parse countries response:', text.substring(0, 500));
        throw new Error('Failed to parse countries data. The API may be returning invalid JSON.');
      }
    }
  },

  async getContinents(): Promise<Continent[]> {
    const response = await fetch(`${API_BASE_URL}/continents`);
    if (!response.ok) {
      throw new Error('Failed to fetch continents');
    }
    return response.json();
  },
};
