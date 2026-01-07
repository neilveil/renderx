import { useEffect, useState } from 'react';
import { api } from '../services/api';
import type { Country } from '../services/api';
import './Countries.css';

export function Countries() {
  const [countries, setCountries] = useState<Country[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    const fetchCountries = async () => {
      try {
        setLoading(true);
        setError(null);
        const data = await api.getCountries();
        if (!Array.isArray(data)) {
          throw new Error('Invalid response format: expected an array');
        }
        setCountries(data);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to load countries';
        console.error('Error fetching countries:', err);
        setError(errorMessage);
      } finally {
        setLoading(false);
      }
    };

    fetchCountries();
  }, []);

  const filteredCountries = countries.filter((country) =>
    country.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    country.code.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (loading) {
    return <div className="loading">Loading countries...</div>;
  }

  if (error) {
    return <div className="error">Error: {error}</div>;
  }

  return (
    <div className="countries-page">
      <div className="page-container">
        <h1>Countries</h1>
        <div className="search-container">
          <input
            type="text"
            placeholder="Search countries by name or code..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="search-input"
          />
          <span className="results-count">
            Showing {filteredCountries.length} of {countries.length} countries
          </span>
        </div>
        <div className="countries-grid">
          {filteredCountries.map((country) => (
            <div key={country.code} className="country-card">
              <h3>{country.name}</h3>
              <span className="country-code">{country.code}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
