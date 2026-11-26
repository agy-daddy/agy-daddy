import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { WorkspacePicker, type WorkspacePickerOption } from './WorkspacePicker';

function makeOptions(count = 22): WorkspacePickerOption[] {
  const list: WorkspacePickerOption[] = [
    {
      value: '/work/current-repo',
      name: 'current-repo',
      path: '/work/current-repo',
      fromSession: true,
    },
  ];
  for (let i = 1; i <= count; i++) {
    list.push({
      value: `/work/other-project-${i}`,
      name: `other-project-${i}`,
      path: `/work/other-project-${i}`,
      fromSession: false,
    });
  }
  return list;
}

describe('WorkspacePicker', () => {
  it('renders trigger with session tag, groups options, and filters by name or path', () => {
    const onChange = vi.fn();
    const options = makeOptions(22);

    render(
      <I18nProvider defaultLocale="en">
        <WorkspacePicker options={options} value="/work/current-repo" onChange={onChange} />
      </I18nProvider>,
    );

    const trigger = screen.getByTestId('dock-root-select');
    expect(trigger).toHaveTextContent('current-repo');
    expect(trigger).toHaveTextContent('Current session');
    expect(trigger).toHaveAttribute('title', '/work/current-repo');

    fireEvent.click(trigger);
    const popover = screen.getByTestId('workspace-picker-popover');
    expect(popover).toBeInTheDocument();
    expect(popover).toHaveTextContent('Current session workspaces');
    expect(popover).toHaveTextContent('Other workspaces');
    expect(screen.getAllByRole('option')).toHaveLength(23);

    const search = screen.getByTestId('workspace-picker-search');
    fireEvent.change(search, { target: { value: 'other-project-19' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByTestId('workspace-picker-option-0')).toHaveTextContent('/work/other-project-19');

    fireEvent.change(search, { target: { value: 'nonexistent-workspace-xyz' } });
    expect(screen.getByTestId('workspace-picker-empty')).toHaveTextContent('No matching workspaces');

    fireEvent.click(screen.getByTestId('workspace-picker-search-clear'));
    expect(screen.getAllByRole('option')).toHaveLength(23);
  });

  it('supports keyboard navigation (ArrowDown/ArrowUp/Enter/Escape) and outside click close', () => {
    const onChange = vi.fn();
    const options = makeOptions(3);

    render(
      <I18nProvider defaultLocale="en">
        <div>
          <WorkspacePicker options={options} value="/work/current-repo" onChange={onChange} />
          <button type="button" data-testid="outside-btn">
            Outside
          </button>
        </div>
      </I18nProvider>,
    );

    const trigger = screen.getByTestId('dock-root-select');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(screen.getByTestId('workspace-picker-popover')).toBeInTheDocument();

    const search = screen.getByTestId('workspace-picker-search');
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'ArrowUp' });
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith('/work/other-project-1');
    expect(screen.queryByTestId('workspace-picker-popover')).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.getByTestId('workspace-picker-popover')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByTestId('workspace-picker-search'), { key: 'Escape' });
    expect(screen.queryByTestId('workspace-picker-popover')).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.getByTestId('workspace-picker-popover')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId('outside-btn'));
    expect(screen.queryByTestId('workspace-picker-popover')).not.toBeInTheDocument();
  });
});
