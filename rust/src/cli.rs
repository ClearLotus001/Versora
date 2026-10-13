use std::env;

#[derive(Clone, Copy)]
pub enum OutputMode {
    Text,
    MetadataJson,
    DiffJson,
    DiffJsonBoth,
    DiffJsonStream,
    PrepareArtifact,
}

pub struct ParsedArgs {
    pub output_mode: OutputMode,
    pub file_path: String,
    pub compare_mode: String,
    pub artifact_dir: Option<String>,
}

fn normalize_compare_mode(value: &str) -> Result<String, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "strict" => Ok("strict".to_string()),
        "content" => Ok("content".to_string()),
        _ => Err("Compare mode must be either 'strict' or 'content'".to_string()),
    }
}

pub fn parse_args() -> Result<ParsedArgs, String> {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        Some("--prepare-artifact") => {
            let base_path = args.next().ok_or_else(|| "Usage: svn_excel_parser --prepare-artifact <base-path> <mine-path> <artifact-dir>".to_string())?;
            let mine_path = args.next().ok_or_else(|| "Usage: svn_excel_parser --prepare-artifact <base-path> <mine-path> <artifact-dir>".to_string())?;
            let artifact_dir = args.next().ok_or_else(|| "Usage: svn_excel_parser --prepare-artifact <base-path> <mine-path> <artifact-dir>".to_string())?;
            if args.next().is_some() {
                return Err("Unexpected prepare-artifact argument".to_string());
            }
            Ok(ParsedArgs {
                output_mode: OutputMode::PrepareArtifact,
                file_path: format!("{base_path}\n{mine_path}"),
                compare_mode: "both".to_string(),
                artifact_dir: Some(artifact_dir),
            })
        }
        Some("--metadata-json") => {
            let file_path = args.next().ok_or_else(|| {
                "Usage: svn_excel_parser --metadata-json <workbook-path>".to_string()
            })?;
            Ok(ParsedArgs {
                output_mode: OutputMode::MetadataJson,
                file_path,
                compare_mode: "strict".to_string(),
                artifact_dir: None,
            })
        }
        Some("--diff-json") => {
            let base_path = args.next().ok_or_else(|| {
                "Usage: svn_excel_parser --diff-json <base-workbook-path> <mine-workbook-path>"
                    .to_string()
            })?;
            let mine_path = args.next().ok_or_else(|| {
                "Usage: svn_excel_parser --diff-json <base-workbook-path> <mine-workbook-path>"
                    .to_string()
            })?;
            let compare_mode = match args.next() {
                Some(flag) if flag == "--compare-mode" => {
                    let value = args
                        .next()
                        .ok_or_else(|| "Usage: svn_excel_parser --diff-json <base-workbook-path> <mine-workbook-path> [--compare-mode strict|content]".to_string())?;
                    normalize_compare_mode(&value)?
                }
                Some(_) => {
                    return Err("Usage: svn_excel_parser --diff-json <base-workbook-path> <mine-workbook-path> [--compare-mode strict|content]".to_string());
                }
                None => "strict".to_string(),
            };
            Ok(ParsedArgs {
                output_mode: OutputMode::DiffJson,
                file_path: format!("{base_path}\n{mine_path}"),
                compare_mode,
                artifact_dir: None,
            })
        }
        Some("--diff-json-both") => {
            let base_path = args.next().ok_or_else(|| {
                "Usage: svn_excel_parser --diff-json-both <base-workbook-path> <mine-workbook-path>"
                    .to_string()
            })?;
            let mine_path = args.next().ok_or_else(|| {
                "Usage: svn_excel_parser --diff-json-both <base-workbook-path> <mine-workbook-path>"
                    .to_string()
            })?;
            Ok(ParsedArgs {
                output_mode: OutputMode::DiffJsonBoth,
                file_path: format!("{base_path}\n{mine_path}"),
                compare_mode: "both".to_string(),
                artifact_dir: None,
            })
        }
        Some("--diff-json-stream") => {
            let base_path = args.next().ok_or_else(|| {
                "Usage: svn_excel_parser --diff-json-stream <base-workbook-path> <mine-workbook-path> <strict|content>"
                    .to_string()
            })?;
            let mine_path = args.next().ok_or_else(|| {
                "Usage: svn_excel_parser --diff-json-stream <base-workbook-path> <mine-workbook-path> <strict|content>"
                    .to_string()
            })?;
            let compare_mode = normalize_compare_mode(&args.next().ok_or_else(|| {
                "Usage: svn_excel_parser --diff-json-stream <base-workbook-path> <mine-workbook-path> <strict|content>"
                    .to_string()
            })?)?;
            Ok(ParsedArgs {
                output_mode: OutputMode::DiffJsonStream,
                file_path: format!("{base_path}\n{mine_path}"),
                compare_mode,
                artifact_dir: None,
            })
        }
        Some(file_path) => Ok(ParsedArgs {
            output_mode: OutputMode::Text,
            file_path: file_path.to_string(),
            compare_mode: "strict".to_string(),
            artifact_dir: None,
        }),
        None => Err("Usage: svn_excel_parser <workbook-path>".to_string()),
    }
}
