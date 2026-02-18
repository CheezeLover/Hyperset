"""
Superset OpenWebUI Tool - Improved Version

This module provides tools for interacting with Apache Superset through OpenWebUI.
It enables AI assistants to interact with and control a Superset instance programmatically.

IMPROVEMENTS IN THIS VERSION:
- Enhanced SQL execution with clear, formatted results
- Combined analyze_data method for seamless workflow
- Better result presentation to encourage query execution
- Automatic schema detection and query suggestions

Features:
- Automatic authentication (no need to call authenticate first)
- Dashboard operations (list, get, create, update, delete)
- Chart management (list, get, create, update, delete)
- Database and dataset operations
- SQL execution with formatted results
- User information and recent activity tracking
- Tag management

Configuration:
Set the following in the Valves settings in OpenWebUI:
- SUPERSET_BASE_URL: Base URL of your Superset instance (default: http://localhost:8088)
- SUPERSET_USERNAME: Username for authentication
- SUPERSET_PASSWORD: Password for authentication
"""

import os
import json
import requests
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class Tools:
    class Valves(BaseModel):
        SUPERSET_BASE_URL: str = Field(
            default="http://localhost:8088",
            description="Base URL of the Superset instance",
        )
        SUPERSET_USERNAME: str = Field(
            default="", description="Username for Superset authentication"
        )
        SUPERSET_PASSWORD: str = Field(
            default="", description="Password for Superset authentication"
        )

    def __init__(self):
        self.valves = self.Valves()
        self._access_token: Optional[str] = None
        self._csrf_token: Optional[str] = None

    def _get_base_url(self) -> str:
        """Get the Superset base URL from valves or environment"""
        return self.valves.SUPERSET_BASE_URL or os.getenv(
            "SUPERSET_BASE_URL", "http://localhost:8088"
        )

    def _get_username(self) -> str:
        """Get the Superset username from valves or environment"""
        return self.valves.SUPERSET_USERNAME or os.getenv("SUPERSET_USERNAME", "")

    def _get_password(self) -> str:
        """Get the Superset password from valves or environment"""
        return self.valves.SUPERSET_PASSWORD or os.getenv("SUPERSET_PASSWORD", "")

    def _get_headers(self, include_csrf: bool = False) -> Dict[str, str]:
        """Get headers for API requests"""
        headers = {
            "Content-Type": "application/json",
            "Referer": self._get_base_url(),
        }
        if self._access_token:
            headers["Authorization"] = f"Bearer {self._access_token}"
        if include_csrf and self._csrf_token:
            headers["X-CSRFToken"] = self._csrf_token
        return headers

    def _get_csrf_token(self) -> Optional[str]:
        """Get a CSRF token from Superset"""
        try:
            response = requests.get(
                f"{self._get_base_url()}/api/v1/security/csrf_token/",
                headers=self._get_headers(),
                timeout=30,
            )
            if response.status_code == 200:
                data = response.json()
                self._csrf_token = data.get("result")
                return self._csrf_token
        except Exception as e:
            print(f"Error getting CSRF token: {e}")
        return None

    def _ensure_authenticated(self) -> Optional[Dict[str, Any]]:
        """
        Ensure we have a valid authentication token.
        Returns None if authenticated successfully, or an error dict if failed.
        """
        # If we already have a token, verify it's still valid
        if self._access_token:
            try:
                response = requests.get(
                    f"{self._get_base_url()}/api/v1/dashboard/",
                    headers=self._get_headers(),
                    timeout=30,
                )
                if response.status_code == 200:
                    return None  # Token is valid
            except Exception:
                pass  # Token invalid, will re-authenticate below

        # Need to authenticate
        username = self._get_username()
        password = self._get_password()

        if not username or not password:
            return {
                "error": "Superset credentials not configured. Please set SUPERSET_USERNAME and SUPERSET_PASSWORD in Valves."
            }

        try:
            response = requests.post(
                f"{self._get_base_url()}/api/v1/security/login",
                headers={"Content-Type": "application/json"},
                json={
                    "username": username,
                    "password": password,
                    "provider": "db",
                    "refresh": True,
                },
                timeout=30,
            )

            if response.status_code != 200:
                return {
                    "error": f"Authentication failed: {response.status_code} - {response.text}"
                }

            data = response.json()
            self._access_token = data.get("access_token")

            if not self._access_token:
                return {"error": "No access token returned from authentication"}

            # Get CSRF token after successful authentication
            self._get_csrf_token()
            return None  # Success

        except Exception as e:
            return {"error": f"Authentication error: {str(e)}"}

    def _make_request(
        self,
        method: str,
        endpoint: str,
        data: Dict[str, Any] = None,
        params: Dict[str, Any] = None,
    ) -> Dict[str, Any]:
        """Make an API request to Superset with automatic authentication"""

        # Ensure we're authenticated first
        auth_error = self._ensure_authenticated()
        if auth_error:
            return auth_error

        url = f"{self._get_base_url()}{endpoint}"
        include_csrf = method.lower() != "get"

        # Get CSRF token for non-GET requests
        if include_csrf and not self._csrf_token:
            self._get_csrf_token()

        headers = self._get_headers(include_csrf=include_csrf)

        try:
            if method.lower() == "get":
                response = requests.get(url, headers=headers, params=params, timeout=30)
            elif method.lower() == "post":
                response = requests.post(
                    url, headers=headers, json=data, params=params, timeout=30
                )
            elif method.lower() == "put":
                response = requests.put(url, headers=headers, json=data, timeout=30)
            elif method.lower() == "delete":
                response = requests.delete(
                    url, headers=headers, params=params, timeout=30
                )
            else:
                return {"error": f"Unsupported HTTP method: {method}"}

            # Handle 401 - try to re-authenticate once
            if response.status_code == 401:
                self._access_token = None  # Force re-authentication
                auth_error = self._ensure_authenticated()
                if auth_error:
                    return auth_error

                # Retry the request
                headers = self._get_headers(include_csrf=include_csrf)
                if method.lower() == "get":
                    response = requests.get(
                        url, headers=headers, params=params, timeout=30
                    )
                elif method.lower() == "post":
                    response = requests.post(
                        url, headers=headers, json=data, params=params, timeout=30
                    )
                elif method.lower() == "put":
                    response = requests.put(url, headers=headers, json=data, timeout=30)
                elif method.lower() == "delete":
                    response = requests.delete(
                        url, headers=headers, params=params, timeout=30
                    )

            if response.status_code not in [200, 201]:
                return {
                    "error": f"API request failed: {response.status_code} - {response.text}"
                }

            return response.json()
        except Exception as e:
            return {"error": f"Request error: {str(e)}"}

    def _format_query_results(
        self, result: Dict[str, Any], original_sql: str = ""
    ) -> str:
        """Format query results with EXPLICIT filter and modification detection"""
        if "error" in result:
            error_msg = result.get("error", "Unknown error")
            if isinstance(error_msg, dict):
                error_msg = error_msg.get("message", str(error_msg))
            return f"❌ ERROR: {error_msg}"

        if "data" not in result:
            return f"⚠️  Unexpected response:\n{json.dumps(result, indent=2)}"

        data_list = result.get("data", [])
        columns = result.get("columns", [])
        query_info = result.get("query", {})

        # CRITICAL: Get the actual executed SQL to detect filters/modifications
        executed_sql = query_info.get("executedSql", "")

        output = []
        output.append("=" * 100)

        # EXPLICITLY show if query was modified (RLS, filters, rewrites)
        if executed_sql and original_sql:
            # Normalize whitespace for comparison
            exec_normalized = " ".join(executed_sql.split())
            orig_normalized = " ".join(original_sql.split())

            if exec_normalized != orig_normalized:
                output.append("🚨 QUERY WAS MODIFIED BY SUPERSET - FILTERS APPLIED!")
                output.append("=" * 100)
                output.append("\n📝 YOUR ORIGINAL SQL:")
                output.append(original_sql)
                output.append("\n🔒 ACTUALLY EXECUTED SQL (with automatic filters):")
                output.append(executed_sql)
                output.append(
                    "\n⚠️  IMPORTANT: The differences above show filters that Superset automatically added."
                )
                output.append(
                    "    This is usually Row-Level Security (RLS) limiting what data you can see."
                )
                output.append("=" * 100)
            else:
                output.append("✅ Query executed exactly as written (no modifications)")
                output.append("=" * 100)
                if executed_sql:
                    output.append(f"SQL: {executed_sql}")
                output.append("=" * 100)
        elif executed_sql:
            output.append("✅ Query executed")
            output.append("=" * 100)
            output.append(f"SQL: {executed_sql}")
            output.append("=" * 100)

        # Results summary
        output.append(f"\n📊 ROWS RETURNED: {len(data_list)}")

        if query_info.get("duration"):
            duration = query_info["duration"]
            if duration > 1000:
                output.append(f"⏱️  Duration: {duration/1000:.2f}s")
            else:
                output.append(f"⏱️  Duration: {duration}ms")

        if not data_list:
            output.append("\n⚠️  ZERO ROWS - Query returned no data")
            output.append("    Possible reasons:")
            output.append("    - No data matches your conditions")
            output.append("    - Table is empty")
            output.append("    - RLS filters excluded all rows")
            return "\n".join(output)

        # Column information
        if columns:
            col_details = []
            for c in columns:
                col_name = c.get("name", "?")
                col_type = c.get("type", "?")
                col_details.append(f"{col_name} ({col_type})")
            output.append(f"\nColumns: {', '.join(col_details)}")

        output.append("\n" + "-" * 100)
        output.append("📋 DATA:")
        output.append("-" * 100)

        # Show data clearly - first 20 rows
        for i, row in enumerate(data_list[:20], 1):
            if isinstance(row, dict):
                # Format as clean key=value pairs
                parts = []
                for k, v in row.items():
                    # Format numbers with commas
                    if isinstance(v, (int, float)) and not isinstance(v, bool):
                        if isinstance(v, float):
                            parts.append(f"{k}={v:,.2f}")
                        else:
                            parts.append(f"{k}={v:,}")
                    else:
                        parts.append(f"{k}={v}")
                output.append(f"  {i:2d}. {' | '.join(parts)}")
            else:
                output.append(f"  {i:2d}. {row}")

        if len(data_list) > 20:
            output.append(
                f"\n  ... +{len(data_list) - 20} more rows (showing first 20 of {len(data_list)} total)"
            )

        # Auto-calculate quick stats for numeric columns
        if data_list and isinstance(data_list[0], dict):
            numeric_cols = []
            first_row = data_list[0]
            for key, val in first_row.items():
                if isinstance(val, (int, float)) and not isinstance(val, bool):
                    numeric_cols.append(key)

            if numeric_cols and len(numeric_cols) <= 5:  # Only if reasonable number
                output.append("\n" + "=" * 100)
                output.append("📈 AUTOMATIC STATISTICS:")
                output.append("-" * 100)

                for col in numeric_cols:
                    try:
                        values = [
                            row.get(col)
                            for row in data_list
                            if isinstance(row.get(col), (int, float))
                        ]
                        if values:
                            total = sum(values)
                            avg = total / len(values)
                            min_val = min(values)
                            max_val = max(values)

                            output.append(f"  {col}:")
                            output.append(
                                f"    Sum: {total:,.2f} | Avg: {avg:,.2f} | Min: {min_val:,} | Max: {max_val:,}"
                            )
                    except:
                        pass

        output.append("=" * 100)
        return "\n".join(output)

    # ===== IMPROVED SQL EXECUTION TOOLS =====

    def execute_sql(
        self,
        database_id: int = Field(..., description="ID of the database to query"),
        sql: str = Field(..., description="SQL query to execute"),
    ) -> str:
        """
        Execute a SQL query and return formatted results.

        This is the PRIMARY method for running SQL queries in Superset.
        Returns results in a clear, readable format with row counts and column info.
        SHOWS EXPLICITLY if Superset modifies your query (RLS filters, etc.)

        Example:
            execute_sql(database_id=1, sql="SELECT * FROM customers LIMIT 10")
        """
        payload = {"database_id": database_id, "sql": sql}

        result = self._make_request("post", "/api/v1/sqllab/execute/", data=payload)
        return self._format_query_results(result, original_sql=sql)

    def analyze_data(
        self,
        question: str = Field(
            ...,
            description="The data question to answer (e.g., 'What are the top 10 customers by revenue?')",
        ),
    ) -> str:
        """
        RECOMMENDED: Analyze data by automatically discovering schema and executing appropriate queries.

        This tool combines schema discovery with SQL execution to answer data questions efficiently.
        It will:
        1. Get available databases and datasets
        2. Show detailed column information with data types

        Use this when you want to explore and query data without manual schema lookup.

        Example:
            analyze_data(question="What are the top selling products this month?")
        """
        # Get catalog
        catalog_result = self.get_data_catalog()

        try:
            catalog_data = json.loads(catalog_result)
        except:
            return f"Error loading data catalog: {catalog_result}"

        if "error" in catalog_data:
            return f"Error: {catalog_data['error']}"

        # Format catalog info for the LLM with detailed column information
        output = []
        output.append("=" * 100)
        output.append("📚 DATA CATALOG - Detailed Schema Information")
        output.append("=" * 100)
        output.append(f"\n🎯 QUESTION: {question}\n")

        databases = catalog_data.get("databases", [])
        output.append(f"📊 Total Databases: {len(databases)}")
        output.append(f"📊 Total Datasets: {catalog_data.get('total_datasets', 0)}\n")

        for db in databases:
            output.append("=" * 100)
            output.append(f"🗄️  DATABASE: {db['name']} (ID: {db['id']})")
            output.append(f"   Type: {db.get('backend', 'Unknown')}")
            output.append(f"   Async queries: {db.get('allow_run_async', False)}")

            datasets = db.get("datasets", [])
            if datasets:
                output.append(f"\n   📋 Available Datasets: {len(datasets)}\n")

                for i, ds in enumerate(datasets, 1):
                    output.append(f"   {i}. TABLE: {ds['table_name']}")
                    if ds.get("schema"):
                        output.append(f"      Schema: {ds['schema']}")
                    output.append(f"      Dataset ID: {ds['id']}")

                    columns = ds.get("columns", [])
                    if columns:
                        output.append(f"      Columns ({len(columns)}):")

                        # Group columns by type for better readability
                        datetime_cols = [c for c in columns if c.get("is_dttm")]
                        numeric_cols = [
                            c
                            for c in columns
                            if c.get("type")
                            and any(
                                t in c["type"].lower()
                                for t in [
                                    "int",
                                    "float",
                                    "double",
                                    "decimal",
                                    "numeric",
                                    "number",
                                ]
                            )
                        ]
                        text_cols = [
                            c
                            for c in columns
                            if c.get("type")
                            and any(
                                t in c["type"].lower()
                                for t in ["varchar", "char", "text", "string"]
                            )
                        ]
                        other_cols = [
                            c
                            for c in columns
                            if c not in datetime_cols + numeric_cols + text_cols
                        ]

                        # Show date/time columns first (most important for analysis)
                        if datetime_cols:
                            output.append("         📅 Date/Time Columns:")
                            for col in datetime_cols:
                                col_type = col.get("type", "UNKNOWN")
                                output.append(
                                    f"            • {col['name']} ({col_type})"
                                )

                        # Show numeric columns (important for aggregations)
                        if numeric_cols:
                            output.append("         🔢 Numeric Columns:")
                            for col in numeric_cols:
                                col_type = col.get("type", "UNKNOWN")
                                output.append(
                                    f"            • {col['name']} ({col_type})"
                                )

                        # Show text columns (useful for grouping)
                        if text_cols:
                            output.append("         📝 Text Columns:")
                            for col in text_cols:
                                col_type = col.get("type", "UNKNOWN")
                                output.append(
                                    f"            • {col['name']} ({col_type})"
                                )

                        # Show other columns
                        if other_cols:
                            output.append("         ⚙️  Other Columns:")
                            for col in other_cols:
                                col_type = col.get("type", "UNKNOWN")
                                output.append(
                                    f"            • {col['name']} ({col_type})"
                                )
                    else:
                        output.append("      ⚠️  No column information available")

                    output.append("")  # Blank line between datasets
            else:
                output.append("   ⚠️  No datasets found in this database\n")

        output.append("=" * 100)
        output.append("\n💡 NEXT STEPS:")
        output.append("-" * 100)
        output.append("\n1. Review the schema above to understand available data")
        output.append(
            "2. Identify which table(s) contain the data needed for your question"
        )

        return "\n".join(output)

    def quick_query(
        self,
        database_id: int = Field(..., description="ID of the database to query"),
        table_name: str = Field(..., description="Name of the table to query"),
        limit: int = Field(
            default=10, description="Maximum rows to return (default: 10)"
        ),
    ) -> str:
        """
        Quick preview of a table's data.

        Executes a simple SELECT * query with formatted results.
        Perfect for exploring table contents.

        Example:
            quick_query(database_id=1, table_name="customers", limit=20)
        """
        sql = f"SELECT * FROM {table_name} LIMIT {limit}"
        return self.execute_sql(database_id=database_id, sql=sql)

    def quick_schema(
        self, dataset_id: int = Field(..., description="ID of the dataset to examine")
    ) -> str:
        """
        Get detailed column information for a specific dataset quickly.

        Returns a formatted, readable list of columns with their types,
        grouped by category (date/time, numeric, text, other).
        Perfect for understanding table structure before writing queries.

        Example:
            quick_schema(dataset_id=5)
        """
        result = self._make_request("get", f"/api/v1/dataset/{dataset_id}")

        if "error" in result:
            return f"❌ Error: {result['error']}"

        dataset_result = result.get("result", {})
        table_name = dataset_result.get("table_name", "Unknown")
        schema = dataset_result.get("schema")
        database_name = dataset_result.get("database", {}).get(
            "database_name", "Unknown"
        )
        columns = dataset_result.get("columns", [])

        if not columns:
            return f"⚠️  No columns found for dataset {dataset_id}"

        output = []
        output.append("=" * 80)
        output.append(f"📋 SCHEMA: {table_name}")
        output.append("=" * 80)
        output.append(f"Database: {database_name}")
        if schema:
            output.append(f"Schema: {schema}")
        output.append(f"Dataset ID: {dataset_id}")
        output.append(f"Total Columns: {len(columns)}\n")

        # Group columns by type
        datetime_cols = [c for c in columns if c.get("is_dttm")]
        numeric_cols = [
            c
            for c in columns
            if c.get("type")
            and any(
                t in c["type"].lower()
                for t in ["int", "float", "double", "decimal", "numeric", "number"]
            )
        ]
        text_cols = [
            c
            for c in columns
            if c.get("type")
            and any(
                t in c["type"].lower() for t in ["varchar", "char", "text", "string"]
            )
        ]
        other_cols = [
            c for c in columns if c not in datetime_cols + numeric_cols + text_cols
        ]

        # Show date/time columns
        if datetime_cols:
            output.append("📅 DATE/TIME COLUMNS:")
            for col in datetime_cols:
                col_name = col.get("column_name", "unknown")
                col_type = col.get("type", "UNKNOWN")
                filterable = "✓" if col.get("filterable") else "✗"
                groupby = "✓" if col.get("groupby") else "✗"
                output.append(f"   • {col_name}")
                output.append(
                    f"     Type: {col_type} | Filter: {filterable} | GroupBy: {groupby}"
                )
            output.append("")

        # Show numeric columns
        if numeric_cols:
            output.append("🔢 NUMERIC COLUMNS:")
            for col in numeric_cols:
                col_name = col.get("column_name", "unknown")
                col_type = col.get("type", "UNKNOWN")
                filterable = "✓" if col.get("filterable") else "✗"
                groupby = "✓" if col.get("groupby") else "✗"
                output.append(f"   • {col_name}")
                output.append(
                    f"     Type: {col_type} | Filter: {filterable} | GroupBy: {groupby}"
                )
            output.append("")

        # Show text columns
        if text_cols:
            output.append("📝 TEXT COLUMNS:")
            for col in text_cols:
                col_name = col.get("column_name", "unknown")
                col_type = col.get("type", "UNKNOWN")
                filterable = "✓" if col.get("filterable") else "✗"
                groupby = "✓" if col.get("groupby") else "✗"
                output.append(f"   • {col_name}")
                output.append(
                    f"     Type: {col_type} | Filter: {filterable} | GroupBy: {groupby}"
                )
            output.append("")

        # Show other columns
        if other_cols:
            output.append("⚙️  OTHER COLUMNS:")
            for col in other_cols:
                col_name = col.get("column_name", "unknown")
                col_type = col.get("type", "UNKNOWN")
                filterable = "✓" if col.get("filterable") else "✗"
                groupby = "✓" if col.get("groupby") else "✗"
                output.append(f"   • {col_name}")
                output.append(
                    f"     Type: {col_type} | Filter: {filterable} | GroupBy: {groupby}"
                )
            output.append("")

        output.append("=" * 80)
        output.append("\n💡 QUICK SQL TEMPLATE:")
        output.append("-" * 80)

        # Get database_id for the template
        db_id = dataset_result.get("database", {}).get("id", "X")

        # Create a sample query template
        sample_cols = []
        if datetime_cols:
            sample_cols.append(datetime_cols[0].get("column_name", "date_col"))
        if numeric_cols:
            sample_cols.append(numeric_cols[0].get("column_name", "numeric_col"))
        if text_cols:
            sample_cols.append(text_cols[0].get("column_name", "text_col"))

        if not sample_cols:
            sample_cols = (
                [columns[0].get("column_name", "column1")] if columns else ["*"]
            )

        full_table_name = f"{schema}.{table_name}" if schema else table_name

        output.append("\nexecute_sql(")
        output.append(f"    database_id={db_id},")
        output.append('    sql="""')
        output.append(f"        SELECT {', '.join(sample_cols[:3])}")
        output.append(f"        FROM {full_table_name}")
        output.append("        WHERE [your conditions]")
        output.append("        LIMIT 100")
        output.append('    """')
        output.append(")\n")
        output.append("=" * 80)

        return "\n".join(output)

    def execute_and_analyze(
        self,
        database_id: int = Field(..., description="ID of the database to query"),
        sql: str = Field(..., description="SQL query to execute"),
        analyze: bool = Field(
            default=True, description="Whether to include data analysis summary"
        ),
    ) -> str:
        """
        Execute SQL query with optional analysis of results.

        Returns formatted results plus basic statistics about the data returned.

        Example:
            execute_and_analyze(database_id=1, sql="SELECT category, COUNT(*) FROM products GROUP BY category")
        """
        # Execute query
        result_str = self.execute_sql(database_id=database_id, sql=sql)

        if not analyze or "❌ Error" in result_str:
            return result_str

        # Try to add analysis
        try:
            # Get raw result for analysis
            payload = {
                "database_id": database_id,
                "sql": sql,
                "schema": "",
                "tab": "OpenWebUI Query",
                "runAsync": False,
                "select_as_cta": False,
            }
            raw_result = self._make_request(
                "post", "/api/v1/sqllab/execute/", data=payload
            )

            if "data" in raw_result:
                data_list = raw_result.get("data", [])
                analysis = [
                    "\n" + "=" * 80,
                    "📈 QUICK ANALYSIS:",
                    f"   Total rows: {len(data_list)}",
                ]

                # Add column analysis if available
                if data_list and isinstance(data_list[0], dict):
                    analysis.append(f"   Columns: {len(data_list[0])}")
                    analysis.append(
                        f"   Column names: {', '.join(data_list[0].keys())}"
                    )

                return result_str + "\n" + "\n".join(analysis)
        except:
            pass

        return result_str

    # ===== Data Discovery Tool (Use First for SQL Queries) =====

    def get_data_catalog(self) -> str:
        """
        Get a comprehensive overview of available databases, datasets, and their schemas.

        This tool provides:
        - List of all accessible databases
        - Available datasets/tables in each database
        - Column names and types for each dataset
        - Database connection info

        After getting this catalog, use execute_sql() to run queries against the data.
        """
        result = {"databases": [], "total_databases": 0, "total_datasets": 0}

        # Get databases
        db_response = self._make_request("get", "/api/v1/database/")
        if "error" in db_response:
            return json.dumps({"error": db_response["error"]})

        databases = db_response.get("result", [])
        result["total_databases"] = len(databases)

        for db in databases:
            db_info = {
                "id": db.get("id"),
                "name": db.get("database_name"),
                "backend": db.get("backend"),
                "allow_run_async": db.get("allow_run_async"),
                "datasets": [],
            }

            # Get datasets for this database
            dataset_response = self._make_request(
                "get",
                "/api/v1/dataset/",
                params={
                    "q": json.dumps(
                        {
                            "filters": [
                                {
                                    "col": "database",
                                    "opr": "rel_o_m",
                                    "value": db.get("id"),
                                }
                            ]
                        }
                    )
                },
            )

            if "error" not in dataset_response:
                datasets = dataset_response.get("result", [])
                result["total_datasets"] += len(datasets)

                # Limit to first 10 datasets per database to avoid too many API calls
                for ds in datasets[:10]:
                    dataset_id = ds.get("id")

                    # Fetch detailed dataset info to get column details
                    detailed_ds = self._make_request(
                        "get", f"/api/v1/dataset/{dataset_id}"
                    )

                    if "error" not in detailed_ds:
                        ds_result = detailed_ds.get("result", {})
                        columns = ds_result.get("columns", [])

                        db_info["datasets"].append(
                            {
                                "id": dataset_id,
                                "table_name": ds.get("table_name"),
                                "schema": ds.get("schema"),
                                "columns": [
                                    {
                                        "name": col.get("column_name"),
                                        "type": col.get("type"),
                                        "is_dttm": col.get("is_dttm", False),
                                        "is_active": col.get("is_active", True),
                                        "python_date_format": col.get(
                                            "python_date_format"
                                        ),
                                    }
                                    for col in columns
                                    if col.get(
                                        "is_active", True
                                    )  # Only show active columns
                                ],
                            }
                        )

            result["databases"].append(db_info)

        return json.dumps(result, indent=2)

    def get_dataset_details(
        self, dataset_id: int = Field(..., description="ID of the dataset to examine")
    ) -> str:
        """
        Get detailed information about a specific dataset including all columns and their properties.

        Use this after get_data_catalog() to get full details on a specific dataset.
        """
        result = self._make_request("get", f"/api/v1/dataset/{dataset_id}")

        if "error" in result:
            return json.dumps(result)

        # Format for better readability
        dataset_result = result.get("result", {})
        formatted = {
            "id": dataset_result.get("id"),
            "database_id": dataset_result.get("database", {}).get("id"),
            "database_name": dataset_result.get("database", {}).get("database_name"),
            "table_name": dataset_result.get("table_name"),
            "schema": dataset_result.get("schema"),
            "columns": [
                {
                    "name": col.get("column_name"),
                    "type": col.get("type"),
                    "is_dttm": col.get("is_dttm"),
                    "is_active": col.get("is_active"),
                    "filterable": col.get("filterable"),
                    "groupby": col.get("groupby"),
                }
                for col in dataset_result.get("columns", [])
            ],
            "metrics": [
                {"name": m.get("metric_name"), "expression": m.get("expression")}
                for m in dataset_result.get("metrics", [])
            ],
        }

        return json.dumps(formatted, indent=2)

    # ===== Dashboard Tools =====

    def list_dashboards(self) -> str:
        """
        Get a list of all accessible dashboards.
        Returns dashboard titles, IDs, URLs, and owners.
        """
        result = self._make_request("get", "/api/v1/dashboard/")
        return json.dumps(result)

    def get_dashboard(
        self,
        dashboard_id: int = Field(..., description="ID of the dashboard to retrieve"),
    ) -> str:
        """
        Get detailed information about a specific dashboard.
        Includes all charts, layout, and configuration.
        """
        result = self._make_request("get", f"/api/v1/dashboard/{dashboard_id}")
        return json.dumps(result)

    def create_dashboard(
        self,
        dashboard_title: str = Field(..., description="Title of the dashboard"),
        json_metadata: Optional[str] = Field(
            default=None, description="Optional JSON metadata as string"
        ),
    ) -> str:
        """
        Create a new dashboard.

        Example:
            create_dashboard(dashboard_title="Sales Analytics Q1")
        """
        payload = {"dashboard_title": dashboard_title}

        if json_metadata:
            try:
                payload["json_metadata"] = json.loads(json_metadata)
            except json.JSONDecodeError:
                return json.dumps({"error": "Invalid JSON metadata format"})

        result = self._make_request("post", "/api/v1/dashboard/", data=payload)
        return json.dumps(result)

    def update_dashboard(
        self,
        dashboard_id: int = Field(..., description="ID of the dashboard to update"),
        data: str = Field(
            ...,
            description="JSON string with update data (dashboard_title, slug, owners, etc.)",
        ),
    ) -> str:
        """
        Update an existing dashboard's properties.
        """
        try:
            update_data = json.loads(data)
        except json.JSONDecodeError:
            return json.dumps({"error": "Invalid JSON data format"})

        result = self._make_request(
            "put", f"/api/v1/dashboard/{dashboard_id}", data=update_data
        )
        return json.dumps(result)

    def delete_dashboard(
        self,
        dashboard_id: int = Field(..., description="ID of the dashboard to delete"),
    ) -> str:
        """
        Delete a dashboard permanently.
        """
        result = self._make_request("delete", f"/api/v1/dashboard/{dashboard_id}")
        if not result.get("error"):
            return json.dumps(
                {"message": f"Dashboard {dashboard_id} deleted successfully"}
            )
        return json.dumps(result)

    # ===== Chart Tools =====

    def list_charts(self) -> str:
        """
        Get a list of all accessible charts.
        Returns chart names, types, and datasources.
        """
        result = self._make_request("get", "/api/v1/chart/")
        return json.dumps(result)

    def get_chart(
        self, chart_id: int = Field(..., description="ID of the chart to retrieve")
    ) -> str:
        """
        Get detailed information about a specific chart.
        Includes visualization settings and query parameters.
        """
        result = self._make_request("get", f"/api/v1/chart/{chart_id}")
        return json.dumps(result)

    def create_chart(
        self,
        slice_name: str = Field(..., description="Name/title of the chart"),
        datasource_id: int = Field(..., description="ID of the dataset"),
        datasource_type: str = Field(
            ..., description="Type of datasource ('table' or 'query')"
        ),
        viz_type: str = Field(
            ...,
            description="Visualization type (e.g., 'bar', 'line', 'pie', 'big_number')",
        ),
        params: str = Field(
            ..., description="JSON string with visualization parameters"
        ),
    ) -> str:
        """
        Create a new chart/visualization.

        Example viz_types: bar, line, pie, big_number, table, area, scatter, bubble, etc.
        """
        try:
            viz_params = json.loads(params)
        except json.JSONDecodeError:
            return json.dumps({"error": "Invalid JSON params format"})

        payload = {
            "slice_name": slice_name,
            "datasource_id": datasource_id,
            "datasource_type": datasource_type,
            "viz_type": viz_type,
            "params": json.dumps(viz_params),
        }

        result = self._make_request("post", "/api/v1/chart/", data=payload)
        return json.dumps(result)

    def update_chart(
        self,
        chart_id: int = Field(..., description="ID of the chart to update"),
        data: str = Field(..., description="JSON string with update data"),
    ) -> str:
        """
        Update an existing chart's properties and settings.
        """
        try:
            update_data = json.loads(data)
        except json.JSONDecodeError:
            return json.dumps({"error": "Invalid JSON data format"})

        result = self._make_request(
            "put", f"/api/v1/chart/{chart_id}", data=update_data
        )
        return json.dumps(result)

    def delete_chart(
        self, chart_id: int = Field(..., description="ID of the chart to delete")
    ) -> str:
        """
        Delete a chart permanently.
        """
        result = self._make_request("delete", f"/api/v1/chart/{chart_id}")
        if not result.get("error"):
            return json.dumps({"message": f"Chart {chart_id} deleted successfully"})
        return json.dumps(result)

    def generate_chart_link(
        self,
        chart_id: int = Field(..., description="ID of the chart to generate link for"),
    ) -> str:
        """
        Generate a link to view a Superset chart.

        This method simply returns the direct URL to the chart in Superset.

        Args:
            chart_id: The ID of the chart to link to

        Returns:
            JSON with chart link and basic information
        """
        # Ensure we're authenticated first
        auth_error = self._ensure_authenticated()
        if auth_error:
            return json.dumps(auth_error)

        base_url = self._get_base_url()

        try:
            # Get chart details for the name
            chart_response = requests.get(
                f"{base_url}/api/v1/chart/{chart_id}",
                headers=self._get_headers(),
                timeout=30,
            )

            if chart_response.status_code == 200:
                chart_data = chart_response.json()
                chart_name = chart_data.get("result", {}).get(
                    "slice_name", f"Chart {chart_id}"
                )
            else:
                chart_name = f"Chart {chart_id}"

            chart_link = f"{base_url}/superset/slice/{chart_id}/"

            return json.dumps(
                {
                    "chart_id": chart_id,
                    "chart_name": chart_name,
                    "chart_link": chart_link,
                    "message": f"Chart '{chart_name}' created successfully. View it at: {chart_link}",
                }
            )

        except Exception as e:
            # Fallback: just provide the link
            chart_link = f"{base_url}/superset/slice/{chart_id}/"

            return json.dumps(
                {
                    "chart_id": chart_id,
                    "chart_link": chart_link,
                    "error": str(e),
                    "message": f"Chart created successfully. View it at: {chart_link}",
                }
            )

    def generate_dashboard_iframe(
        self,
        dashboard_id: int = Field(
            ..., description="ID of the dashboard to generate iframe for"
        ),
    ) -> str:
        """
        Generate an iframe HTML snippet for embedding a Superset dashboard with guest token authentication.

        This method creates a guest token that allows embedding the dashboard without requiring
        users to authenticate. The token has limited permissions (only read access to this dashboard)
        and a 5-minute expiration.

        IMPORTANT: This works for dashboards. For individual charts, use generate_chart_iframe()
        which uses session authentication instead.

        Args:
            dashboard_id: The ID of the dashboard to embed

        Returns:
            JSON with iframe HTML and guest token information
        """
        # Ensure we're authenticated first
        auth_error = self._ensure_authenticated()
        if auth_error:
            return json.dumps(auth_error)

        # Create guest token for embedded dashboard
        guest_token_payload = {
            "resources": [{"type": "dashboard", "id": str(dashboard_id)}],
            "rls": [],
            "user": {"username": "guest", "first_name": "Guest", "last_name": "User"},
        }

        try:
            # Get guest token
            response = requests.post(
                f"{self._get_base_url()}/api/v1/security/guest_token/",
                headers=self._get_headers(include_csrf=True),
                json=guest_token_payload,
                timeout=30,
            )

            if response.status_code != 200:
                # If guest token fails, provide iframe without token (requires user to be logged in)
                base_url = self._get_base_url()
                iframe_url = (
                    f"{base_url}/superset/dashboard/{dashboard_id}/?standalone=true"
                )
                iframe_html = f'<iframe src="{iframe_url}" width="100%" height="600" frameborder="0"></iframe>'

                return json.dumps(
                    {
                        "iframe_html": iframe_html,
                        "dashboard_id": dashboard_id,
                        "base_url": base_url,
                        "standalone_url": iframe_url,
                        "note": "Guest token not available - iframe requires user to be logged into Superset. Make sure EMBEDDED_SUPERSET feature flag is enabled in superset_config.py",
                        "guest_token_error": response.text,
                        "status_code": response.status_code,
                    }
                )

            guest_data = response.json()
            guest_token = guest_data.get("token")

            if not guest_token:
                # Fallback to standalone URL without token
                base_url = self._get_base_url()
                iframe_url = (
                    f"{base_url}/superset/dashboard/{dashboard_id}/?standalone=true"
                )
                iframe_html = (
                    f'<iframe src="{iframe_url}" width="100%" height="600"></iframe>'
                )

                return json.dumps(
                    {
                        "iframe_html": iframe_html,
                        "dashboard_id": dashboard_id,
                        "base_url": base_url,
                        "standalone_url": iframe_url,
                        "note": "Guest token not returned - iframe requires user to be logged into Superset",
                        "response_data": guest_data,
                    }
                )

            # Build embedded URL with guest token
            base_url = self._get_base_url()
            iframe_url = f"{base_url}/superset/dashboard/{dashboard_id}/?standalone=true&guest_token={guest_token}"

            # Generate iframe HTML
            iframe_html = f'<iframe src="{iframe_url}" width="100%" height="600" frameborder="0" allowfullscreen></iframe>'

            return json.dumps(
                {
                    "iframe_html": iframe_html,
                    "dashboard_id": dashboard_id,
                    "base_url": base_url,
                    "standalone_url": f"{base_url}/superset/dashboard/{dashboard_id}/?standalone=true",
                    "embedded_url": iframe_url,
                    "guest_token": guest_token,
                    "token_expires_in": "5 minutes (300 seconds)",
                    "note": "Use iframe_html to embed the dashboard. The guest token allows viewing without authentication for 5 minutes.",
                }
            )

        except Exception as e:
            # If anything fails, provide basic iframe without token
            base_url = self._get_base_url()
            iframe_url = (
                f"{base_url}/superset/dashboard/{dashboard_id}/?standalone=true"
            )
            iframe_html = f'<iframe src="{iframe_url}" width="100%" height="600" frameborder="0"></iframe>'

            return json.dumps(
                {
                    "iframe_html": iframe_html,
                    "dashboard_id": dashboard_id,
                    "base_url": base_url,
                    "standalone_url": iframe_url,
                    "note": "Error generating guest token - iframe requires user to be logged into Superset",
                    "error": str(e),
                    "error_type": type(e).__name__,
                }
            )

    def get_available_chart_types(self) -> str:
        """
        Get comprehensive information about available chart/visualization types and their configuration requirements.

        Returns detailed information for each viz_type including:
        - Available visualization types (echarts_timeseries_line, echarts_timeseries_bar, pie, table, big_number, etc.)
        - Required and optional parameters for each type
        - Common configurations and field structures
        - Example parameter structures for creating charts

        This is useful when you need to know:
        - What chart types are supported
        - What fields are required for a specific chart type
        - How to structure the params object when creating charts
        """

        chart_types_info = {
            "message": "Available chart types and their parameter requirements - ECharts-focused selection",
            "common_parameters": {
                "description": "Parameters common to most/all chart types",
                "fields": {
                    "datasource": "Format: '{datasource_id}__{datasource_type}' (e.g., '1__table')",
                    "viz_type": "The visualization type identifier (see chart_types below)",
                    "time_grain_sqla": "Time granularity for time series (P1D=daily, P1W=weekly, P1M=monthly, P1Y=yearly)",
                    "time_range": "Time range filter (e.g., 'Last week', 'No filter', '2020-01-01 : 2020-12-31')",
                    "adhoc_filters": "List of filter objects for filtering data",
                    "row_limit": "Maximum number of rows to return (default: 10000)",
                    "color_scheme": "Color scheme for the chart (e.g., 'supersetColors', 'bnbColors')",
                },
            },
            "chart_types": {
                "echarts_timeseries_line": {
                    "viz_type": "echarts_timeseries_line",
                    "description": "Modern line chart (ECharts) - BEST for time series trends",
                    "required_params": ["metrics", "x_axis"],
                    "common_params": {
                        "metrics": "List of adhoc metric objects (y-axis values)",
                        "x_axis": "X-axis column (typically a time/date column)",
                        "groupby": "List of columns for line breakdown/series",
                        "time_grain_sqla": "Time granularity (P1D, P1W, P1M, P1Y)",
                        "time_range": "Time range filter",
                        "show_legend": "Boolean, show/hide legend",
                        "markerEnabled": "Boolean, show data point markers",
                        "y_axis_format": "Format for y-axis values",
                        "color_scheme": "Color palette",
                    },
                },
                "echarts_timeseries_bar": {
                    "viz_type": "echarts_timeseries_bar",
                    "description": "Modern bar chart (ECharts) - BEST for time series AND categorical comparisons",
                    "required_params": ["metrics", "x_axis"],
                    "common_params": {
                        "metrics": "List of adhoc metric objects (y-axis values)",
                        "x_axis": "X-axis column (time column OR category column)",
                        "groupby": "List of columns for grouping/breakdown",
                        "time_grain_sqla": "Time granularity (P1D, P1W, P1M, P1Y) - only for time series",
                        "time_range": "Time range filter - only for time series",
                        "row_limit": "Number of rows to display",
                        "color_scheme": "Color palette",
                        "show_legend": "Boolean, show/hide legend",
                        "show_value": "Boolean, display values on bars",
                        "stack": "Boolean, stack bars",
                        "y_axis_format": "Format string for y-axis",
                    },
                },
                "echarts_area": {
                    "viz_type": "echarts_area",
                    "description": "Modern area chart (ECharts) - BEST for filled/stacked time series",
                    "required_params": ["metrics", "x_axis"],
                    "common_params": {
                        "metrics": "List of adhoc metric objects",
                        "x_axis": "X-axis column (time column)",
                        "groupby": "Grouping columns for multiple series",
                        "time_grain_sqla": "Time granularity",
                        "time_range": "Time range",
                        "stack": "Boolean, stack areas",
                        "show_legend": "Boolean",
                        "opacity": "Area opacity (0.0 to 1.0)",
                        "markerEnabled": "Boolean, show markers",
                    },
                },
                "echarts_timeseries_scatter": {
                    "viz_type": "echarts_timeseries_scatter",
                    "description": "Modern scatter plot (ECharts) for time series correlation analysis",
                    "required_params": ["metrics", "x_axis"],
                    "common_params": {
                        "metrics": "Adhoc metrics for y-axis",
                        "x_axis": "X-axis column (time column)",
                        "groupby": "Grouping for different series",
                        "time_grain_sqla": "Time granularity",
                        "time_range": "Time range",
                    },
                },
                "table": {
                    "viz_type": "table",
                    "description": "Tabular view of data - use for detailed data display",
                    "required_params": ["query_mode"],
                    "common_params": {
                        "query_mode": "Set to 'aggregate' or 'raw'",
                        "groupby": "List of column names to group by",
                        "metrics": "List of adhoc metric objects (aggregations)",
                        "all_columns": "List of all columns to display (for raw mode)",
                        "percent_metrics": "List of metrics to show as percentages",
                        "row_limit": "Number of rows to display",
                        "order_desc": "Boolean, whether to sort descending",
                        "table_timestamp_format": "Format for timestamp columns",
                    },
                },
                "pie": {
                    "viz_type": "pie",
                    "description": "Pie chart for proportional data (limit to <7 slices for readability)",
                    "required_params": ["metric", "groupby"],
                    "common_params": {
                        "metric": "Single adhoc metric object to determine slice sizes",
                        "groupby": "List with one column to create slices",
                        "row_limit": "Number of slices to show (recommend ≤7)",
                        "color_scheme": "Color palette",
                        "show_legend": "Boolean, show/hide legend",
                        "show_labels": "Boolean, show slice labels",
                        "labels_outside": "Boolean, labels outside slices",
                        "number_format": "Format for numbers",
                        "donut": "Boolean, create donut chart",
                    },
                },
                "big_number": {
                    "viz_type": "big_number",
                    "description": "Single large number display (KPI) - use for key metrics",
                    "required_params": ["metric"],
                    "common_params": {
                        "metric": "Single adhoc metric object to display",
                        "subheader": "Subheader text",
                        "y_axis_format": "Format for the number",
                        "time_range": "Time range for calculation",
                    },
                },
                "big_number_total": {
                    "viz_type": "big_number_total",
                    "description": "Big number with trend sparkline - use for KPI with historical context",
                    "required_params": ["metric"],
                    "common_params": {
                        "metric": "Adhoc metric object to display",
                        "subheader": "Subheader text",
                        "y_axis_format": "Number format",
                        "time_grain_sqla": "Time granularity for trend",
                        "time_range": "Time range",
                    },
                },
                "pivot_table_v2": {
                    "viz_type": "pivot_table_v2",
                    "description": "Pivot table with aggregations - use for multi-dimensional analysis",
                    "required_params": ["groupby"],
                    "common_params": {
                        "groupby": "List of row grouping columns",
                        "columns": "List of column grouping columns",
                        "metrics": "List of adhoc metric objects for aggregations",
                        "aggregateFunction": "Aggregation function (Sum, Average, etc.)",
                        "row_limit": "Number of rows",
                    },
                },
            },
            "important_notes": {
                "echarts_recommendation": "Always use ECharts versions (echarts_timeseries_line, echarts_timeseries_bar, echarts_area) for time series data. They offer better performance, interactivity, and features.",
                "viz_type_usage": "The viz_type field shown above is the EXACT string you must use when creating charts. Copy it exactly.",
                "metrics_must_be_adhoc": "CRITICAL: metrics must always be adhoc metric objects, never simple strings like 'COUNT(*)'",
            },
            "metric_definition_format": {
                "description": "How to define metrics in params - ALWAYS use adhoc format for reliability",
                "IMPORTANT": "DO NOT use simple strings like 'COUNT(*)' - they often fail. Use the adhoc format below.",
                "adhoc_format_required": {
                    "description": "The CORRECT way to define metrics that actually works",
                    "count_all_example": {
                        "expressionType": "SQL",
                        "sqlExpression": "COUNT(*)",
                        "label": "COUNT(*)",
                        "aggregate": None,
                        "column": None,
                    },
                    "count_column_example": {
                        "expressionType": "SIMPLE",
                        "column": {"column_name": "review_id"},
                        "aggregate": "COUNT",
                        "label": "COUNT(review_id)",
                    },
                    "sum_example": {
                        "expressionType": "SIMPLE",
                        "column": {"column_name": "sales_amount"},
                        "aggregate": "SUM",
                        "label": "Total Sales",
                    },
                    "average_example": {
                        "expressionType": "SIMPLE",
                        "column": {"column_name": "price"},
                        "aggregate": "AVG",
                        "label": "Average Price",
                    },
                    "custom_sql_example": {
                        "expressionType": "SQL",
                        "sqlExpression": "SUM(price * quantity)",
                        "label": "Total Revenue",
                    },
                },
                "expression_types": {
                    "SIMPLE": "Use with aggregate + column for basic aggregations (COUNT, SUM, AVG, MIN, MAX, COUNT_DISTINCT)",
                    "SQL": "Use for custom SQL expressions like COUNT(*), calculations, or complex metrics",
                },
                "aggregates": ["COUNT", "SUM", "AVG", "MIN", "MAX", "COUNT_DISTINCT"],
                "metrics_field_format": "Must be a LIST of adhoc metric objects, not strings. Example: metrics=[{adhoc_object1}, {adhoc_object2}]",
            },
            "metric_examples_by_use_case": {
                "count_all_rows": {
                    "expressionType": "SQL",
                    "sqlExpression": "COUNT(*)",
                    "label": "Row Count",
                },
                "count_distinct_customers": {
                    "expressionType": "SIMPLE",
                    "column": {"column_name": "customer_id"},
                    "aggregate": "COUNT_DISTINCT",
                    "label": "Unique Customers",
                },
                "total_revenue": {
                    "expressionType": "SIMPLE",
                    "column": {"column_name": "revenue"},
                    "aggregate": "SUM",
                    "label": "Total Revenue",
                },
                "average_rating": {
                    "expressionType": "SIMPLE",
                    "column": {"column_name": "rating"},
                    "aggregate": "AVG",
                    "label": "Avg Rating",
                },
            },
            "filter_definition_format": {
                "description": "How to define filters in adhoc_filters",
                "example": {
                    "expressionType": "SIMPLE",
                    "clause": "WHERE",
                    "subject": "category",
                    "operator": "==",
                    "comparator": "Electronics",
                },
                "operators": [
                    "==",
                    "!=",
                    ">",
                    "<",
                    ">=",
                    "<=",
                    "IN",
                    "NOT IN",
                    "LIKE",
                    "REGEX",
                ],
            },
            "usage_example": {
                "description": "Example of creating a bar chart with CORRECT metric format",
                "example": {
                    "slice_name": "Sales by Category",
                    "viz_type": "echarts_timeseries_bar",
                    "datasource_id": 1,
                    "datasource_type": "table",
                    "params": {
                        "datasource": "1__table",
                        "viz_type": "echarts_timeseries_bar",
                        "x_axis": "category",
                        "metrics": [
                            {
                                "expressionType": "SQL",
                                "sqlExpression": "COUNT(*)",
                                "label": "Count",
                            }
                        ],
                        "row_limit": 10,
                        "color_scheme": "supersetColors",
                        "show_legend": True,
                        "show_value": True,
                    },
                },
                "time_series_example": {
                    "slice_name": "Sales Over Time",
                    "viz_type": "echarts_timeseries_line",
                    "datasource_id": 1,
                    "datasource_type": "table",
                    "params": {
                        "datasource": "1__table",
                        "viz_type": "echarts_timeseries_line",
                        "x_axis": "order_date",
                        "time_grain_sqla": "P1D",
                        "time_range": "Last month",
                        "metrics": [
                            {
                                "expressionType": "SIMPLE",
                                "column": {"column_name": "sales_amount"},
                                "aggregate": "SUM",
                                "label": "Total Sales",
                            }
                        ],
                    },
                },
            },
            "note": "When creating charts, the 'params' object should include the viz_type and datasource fields along with the type-specific parameters. The datasource_id and datasource_type are separate fields in the chart creation payload. CRITICAL: metrics must be a list of adhoc metric objects, NOT strings.",
        }

        return json.dumps(chart_types_info, indent=2)

    # ===== Database Tools =====

    def list_databases(self) -> str:
        """
        Get a list of all database connections.
        """
        result = self._make_request("get", "/api/v1/database/")
        return json.dumps(result)

    def get_database(
        self,
        database_id: int = Field(..., description="ID of the database to retrieve"),
    ) -> str:
        """
        Get detailed information about a specific database connection.
        """
        result = self._make_request("get", f"/api/v1/database/{database_id}")
        return json.dumps(result)

    def get_database_tables(
        self, database_id: int = Field(..., description="ID of the database")
    ) -> str:
        """
        Get all tables available in a database.
        Returns schema and table name information.
        """
        result = self._make_request("get", f"/api/v1/database/{database_id}/tables/")
        return json.dumps(result)

    def get_database_schemas(
        self, database_id: int = Field(..., description="ID of the database")
    ) -> str:
        """
        Get all schemas in a database.
        """
        result = self._make_request("get", f"/api/v1/database/{database_id}/schemas/")
        return json.dumps(result)

    def validate_sql(
        self,
        database_id: int = Field(..., description="ID of the database"),
        sql: str = Field(..., description="SQL query to validate"),
    ) -> str:
        """
        Validate SQL syntax without executing it.
        """
        payload = {"sql": sql}
        result = self._make_request(
            "post", f"/api/v1/database/{database_id}/validate_sql/", data=payload
        )
        return json.dumps(result)

    # ===== Dataset Tools =====

    def list_datasets(self) -> str:
        """
        Get a list of all datasets.
        """
        result = self._make_request("get", "/api/v1/dataset/")
        return json.dumps(result)

    def get_dataset(
        self, dataset_id: int = Field(..., description="ID of the dataset to retrieve")
    ) -> str:
        """
        Get detailed information about a specific dataset.
        """
        result = self._make_request("get", f"/api/v1/dataset/{dataset_id}")
        return json.dumps(result)

    def create_dataset(
        self,
        table_name: str = Field(..., description="Name of the database table"),
        database_id: int = Field(..., description="ID of the database"),
        schema: str = Field(default="", description="Schema name (optional)"),
    ) -> str:
        """
        Create a new dataset from an existing database table.
        """
        payload = {
            "table_name": table_name,
            "database": database_id,
        }
        if schema:
            payload["schema"] = schema

        result = self._make_request("post", "/api/v1/dataset/", data=payload)
        return json.dumps(result)

    # ===== Additional SQL Lab Tools =====

    def format_sql(
        self, sql: str = Field(..., description="SQL query to format")
    ) -> str:
        """
        Format a SQL query for better readability.
        """
        payload = {"sql": sql}
        result = self._make_request("post", "/api/v1/sqllab/format_sql", data=payload)
        return json.dumps(result)

    def list_saved_queries(self) -> str:
        """
        Get a list of saved queries from SQL Lab.
        """
        result = self._make_request("get", "/api/v1/saved_query/")
        return json.dumps(result)

    def get_saved_query(
        self,
        query_id: int = Field(..., description="ID of the saved query to retrieve"),
    ) -> str:
        """
        Get details for a specific saved query.
        """
        result = self._make_request("get", f"/api/v1/saved_query/{query_id}")
        return json.dumps(result)

    def create_saved_query(
        self,
        label: str = Field(..., description="Display name for the saved query"),
        db_id: int = Field(..., description="Database ID"),
        sql: str = Field(..., description="SQL query text"),
        schema: str = Field(default="", description="Schema name (optional)"),
        description: str = Field(
            default="", description="Description of the query (optional)"
        ),
    ) -> str:
        """
        Save a SQL query for later reuse.
        """
        payload = {
            "label": label,
            "db_id": db_id,
            "sql": sql,
        }
        if schema:
            payload["schema"] = schema
        if description:
            payload["description"] = description

        result = self._make_request("post", "/api/v1/saved_query/", data=payload)
        return json.dumps(result)

    def get_sql_results(
        self, key: str = Field(..., description="Result key from an async query")
    ) -> str:
        """
        Get results of a previously executed async SQL query.
        """
        result = self._make_request(
            "get", "/api/v1/sqllab/results/", params={"key": key}
        )
        return self._format_query_results(result)

    def estimate_query_cost(
        self,
        database_id: int = Field(..., description="ID of the database"),
        sql: str = Field(..., description="SQL query to estimate"),
        schema: str = Field(default="", description="Optional schema name"),
    ) -> str:
        """
        Estimate the cost of executing a SQL query before running it.
        """
        payload = {
            "database_id": database_id,
            "sql": sql,
        }
        if schema:
            payload["schema"] = schema

        result = self._make_request("post", "/api/v1/sqllab/estimate", data=payload)
        return json.dumps(result)

    # ===== Query Management Tools =====

    def list_queries(self) -> str:
        """
        Get query history from Superset.
        """
        result = self._make_request("get", "/api/v1/query/")
        return json.dumps(result)

    def get_query(
        self, query_id: int = Field(..., description="ID of the query to retrieve")
    ) -> str:
        """
        Get details for a specific query execution.
        """
        result = self._make_request("get", f"/api/v1/query/{query_id}")
        return json.dumps(result)

    def stop_query(
        self, client_id: str = Field(..., description="Client ID of the query to stop")
    ) -> str:
        """
        Stop a running query.
        """
        payload = {"client_id": client_id}
        result = self._make_request("post", "/api/v1/query/stop", data=payload)
        return json.dumps(result)

    # ===== User and Activity Tools =====

    def get_current_user(self) -> str:
        """
        Get information about the currently authenticated user.
        """
        result = self._make_request("get", "/api/v1/me/")
        return json.dumps(result)

    def get_user_roles(self) -> str:
        """
        Get roles assigned to the current user.
        """
        result = self._make_request("get", "/api/v1/me/roles/")
        return json.dumps(result)

    def get_recent_activity(self) -> str:
        """
        Get recent activity data for the current user.
        """
        result = self._make_request("get", "/api/v1/log/recent_activity/")
        return json.dumps(result)

    # ===== Tag Tools =====

    def list_tags(self) -> str:
        """
        Get a list of all tags.
        """
        result = self._make_request("get", "/api/v1/tag/")
        return json.dumps(result)

    def get_tag(
        self, tag_id: int = Field(..., description="ID of the tag to retrieve")
    ) -> str:
        """
        Get details for a specific tag.
        """
        result = self._make_request("get", f"/api/v1/tag/{tag_id}")
        return json.dumps(result)

    def create_tag(self, name: str = Field(..., description="Name for the tag")) -> str:
        """
        Create a new tag.
        """
        payload = {"name": name}
        result = self._make_request("post", "/api/v1/tag/", data=payload)
        return json.dumps(result)

    def delete_tag(
        self, tag_id: int = Field(..., description="ID of the tag to delete")
    ) -> str:
        """
        Delete a tag permanently.
        """
        result = self._make_request("delete", f"/api/v1/tag/{tag_id}")
        if not result.get("error"):
            return json.dumps({"message": f"Tag {tag_id} deleted successfully"})
        return json.dumps(result)

    def get_tagged_objects(self) -> str:
        """
        Get all objects that have tags assigned to them.
        """
        result = self._make_request("get", "/api/v1/tag/get_objects/")
        return json.dumps(result)

    def add_tag_to_object(
        self,
        object_type: str = Field(
            ..., description="Type of the object ('chart', 'dashboard', etc.)"
        ),
        object_id: int = Field(..., description="ID of the object to tag"),
        tag_name: str = Field(..., description="Name of the tag to apply"),
    ) -> str:
        """
        Add a tag to a chart, dashboard, or other object.
        """
        payload = {
            "object_type": object_type,
            "object_id": object_id,
            "tag_name": tag_name,
        }
        result = self._make_request("post", "/api/v1/tag/tagged_objects", data=payload)
        return json.dumps(result)

    def remove_tag_from_object(
        self,
        object_type: str = Field(
            ..., description="Type of the object ('chart', 'dashboard', etc.)"
        ),
        object_id: int = Field(..., description="ID of the object to untag"),
        tag_name: str = Field(..., description="Name of the tag to remove"),
    ) -> str:
        """
        Remove a tag from an object.
        """
        result = self._make_request(
            "delete",
            f"/api/v1/tag/{object_type}/{object_id}",
            params={"tag_name": tag_name},
        )
        if not result.get("error"):
            return json.dumps(
                {
                    "message": f"Tag '{tag_name}' removed from {object_type} {object_id} successfully"
                }
            )
        return json.dumps(result)

    # ===== Utility Tools =====

    def get_menu(self) -> str:
        """
        Get the Superset menu structure based on user permissions.
        """
        result = self._make_request("get", "/api/v1/menu/")
        return json.dumps(result)

    def get_superset_base_url(self) -> str:
        """
        Get the base URL of the connected Superset instance.
        """
        return json.dumps(
            {
                "base_url": self._get_base_url(),
                "message": f"Connected to Superset instance at: {self._get_base_url()}",
            }
        )

    def check_auth_status(self) -> str:
        """
        Check if authentication is valid and working.
        """
        auth_error = self._ensure_authenticated()
        if auth_error:
            return json.dumps(auth_error)
        return json.dumps(
            {
                "authenticated": True,
                "message": "Successfully authenticated with Superset",
            }
        )
