# `utils`

This directory contains functions which are used in different places throughout
the codebase, so they can't be put anywhere else.

## `file.ts`

Contains utility functions for reading file contents.

## `log.ts`

Provides wrapper functions for printing out debug messages.

## `settings.ts`

Provides wrappers around the GSettings object that add type safety and
automatically convert values between JS types and GLib Variant types that are
used for storing GSettings.
