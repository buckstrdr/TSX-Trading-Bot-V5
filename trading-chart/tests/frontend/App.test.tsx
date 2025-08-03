import React from 'react';
import { render } from '@testing-library/react';
import App from '../../src/frontend/App';

describe('App', () => {
  it('should render the App component', () => {
    const { getByText } = render(<App />);
    expect(getByText('Trading Chart')).toBeInTheDocument();
  });
});
